import type { DeckBackend } from './deck-backend.js';
import { MUTATION_LOCK } from './mutation-queue.js';
import { serviceRetryDeadline } from './mutation-retry.js';
import { sameDestination, type MutationDestination } from './mutation-storage.js';
import {
  isUnchangedEdit,
  normalizedPair,
  samePair,
  validateSource,
  type CardOperation,
  type Pair,
  type SeenIncrement,
} from './onedrive/operations.js';
import { seenStorage, type StoredSeenBatch } from './seen-storage.js';
import type { DeckState } from './types.js';

export type SeenStorage = Pick<typeof seenStorage, 'list' | 'put' | 'remove'>;

export type SeenSyncStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'retrying'; retryAt: number };

export interface SeenQueueCallbacks {
  isBusy?: () => boolean;
  onFlush?: (source: string, revision: string | null) => void;
  onStatusChange?: (status: SeenSyncStatus) => void;
}

export interface SeenQueueOptions {
  flushDelayMs?: number;
  flushThreshold?: number;
  now?: () => number;
  random?: () => number;
}

const MAX_BACKOFF_MS = 300_000;

export function seenRetryDeadline(error: unknown, attempts: number, now: number, jitter: number): number {
  if (!Number.isInteger(attempts) || attempts < 0 || !Number.isFinite(now) || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new Error('Invalid seen retry scheduler input.');
  }
  const baseDelay = Math.min(MAX_BACKOFF_MS, 2000 * (2 ** Math.min(attempts, 8)));
  const delay = baseDelay * (1 + jitter * 0.25);
  const serviceDeadline = serviceRetryDeadline(error, now);
  return serviceDeadline !== null ? Math.max(serviceDeadline, now + delay) : now + delay;
}

export function incrementDeckSeen(deck: DeckState, source: string, pair: Pair, delta = 1): DeckState {
  if (!Number.isSafeInteger(delta) || delta <= 0) {
    throw new Error('Deck seen increment delta must be a positive safe integer.');
  }
  const target = normalizedPair(pair);
  let changed = false;
  const cards = deck.cards.map(card => {
    if (card.source !== source || !samePair(card, target)) return card;
    changed = true;
    return { ...card, seen: card.seen + delta };
  });
  return changed ? { ...deck, cards } : deck;
}

function mergeIncrement(increments: SeenIncrement[], pair: Pair, delta: number): SeenIncrement[] {
  const target = normalizedPair(pair);
  const next = increments.map(item => ({ ...item }));
  const existing = next.find(item => samePair(item, target));
  if (existing) {
    existing.delta += delta;
  } else {
    next.push({ question: target.question, answer: target.answer, delta });
  }
  return next;
}

function subtractIncrements(current: SeenIncrement[], flushed: ReadonlyArray<SeenIncrement>): SeenIncrement[] {
  const consumed = new Map<string, number>();
  for (const item of flushed) {
    const key = JSON.stringify([item.question, item.answer]);
    consumed.set(key, (consumed.get(key) ?? 0) + item.delta);
  }
  const remaining: SeenIncrement[] = [];
  for (const item of current) {
    const key = JSON.stringify([item.question, item.answer]);
    const delta = item.delta - (consumed.get(key) ?? 0);
    if (delta > 0) remaining.push({ ...item, delta });
  }
  return remaining;
}

function retargetIncrements(increments: SeenIncrement[], operation: CardOperation): SeenIncrement[] {
  if (!operation.original) throw new Error('Retargeting requires the original card pair.');
  const original = operation.original;
  let result: SeenIncrement[] = [];
  for (const item of increments) {
    if (!samePair(item, original)) {
      result = mergeIncrement(result, item, item.delta);
    } else if (operation.action === 'edit') {
      result = mergeIncrement(result, operation.replacement, item.delta);
    }
  }
  return result;
}

export function deriveSeenSyncStatus(batches: ReadonlyArray<StoredSeenBatch>, currentTime: number): SeenSyncStatus {
  if (!batches.length) return { kind: 'idle' };
  let earliestRetry: number | null = null;
  for (const batch of batches) {
    if (batch.retryAt === undefined || batch.retryAt <= currentTime) {
      return { kind: 'saving' };
    }
    earliestRetry = earliestRetry === null ? batch.retryAt : Math.min(earliestRetry, batch.retryAt);
  }
  return { kind: 'retrying', retryAt: earliestRetry! };
}

function sameSyncStatus(a: SeenSyncStatus, b: SeenSyncStatus): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'retrying' || a.retryAt === (b as { kind: 'retrying'; retryAt: number }).retryAt;
}

export function createSeenQueue(
  callbacks: SeenQueueCallbacks = {},
  storage: SeenStorage = seenStorage,
  options: SeenQueueOptions = {},
) {
  const flushDelayMs = options.flushDelayMs ?? 4000;
  const flushThreshold = options.flushThreshold ?? 3;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  let backend: DeckBackend | undefined;
  let closed = false;
  let running = false;
  let flushing = false;
  let wakeRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextRunAt: number | null = null;
  let storageChain = Promise.resolve();
  let lastStatus: SeenSyncStatus = { kind: 'idle' };

  function emitStatus(next: SeenSyncStatus) {
    if (closed || sameSyncStatus(lastStatus, next)) return;
    lastStatus = next;
    callbacks.onStatusChange?.(next);
  }

  function enqueueStorage<T>(action: () => Promise<T>): Promise<T> {
    const task = storageChain.then(action);
    storageChain = task.then(() => undefined, () => undefined);
    return task;
  }

  function clearSchedule() {
    clearTimeout(timer);
    timer = undefined;
    nextRunAt = null;
  }

  function scheduleAt(timestamp: number) {
    if (closed) return;
    if (nextRunAt !== null && nextRunAt <= timestamp) return;
    clearTimeout(timer);
    nextRunAt = timestamp;
    const delay = Math.max(0, Math.min(timestamp - now(), 2_147_483_647));
    timer = setTimeout(() => {
      nextRunAt = null;
      void pump();
    }, delay);
  }

  function schedule(ms: number) {
    scheduleAt(now() + Math.max(0, ms));
  }

  async function matchingBatches(destination: MutationDestination): Promise<StoredSeenBatch[]> {
    const items = await storage.list();
    const matched: StoredSeenBatch[] = [];
    for (const item of items) {
      if (await sameDestination(item.destination, destination)) matched.push(item);
    }
    return matched;
  }

  async function record(source: string, pair: Pair, delta = 1): Promise<void> {
    validateSource(source);
    if (!Number.isSafeInteger(delta) || delta <= 0) {
      throw new Error('Seen record delta must be a positive safe integer.');
    }
    const current = backend?.persistent;
    if (closed || !current?.flushSeen) return;
    const { totalPending, updatedBatches } = await enqueueStorage(async () => {
      const batches = await matchingBatches(current.destination);
      const existing = batches.find(batch => batch.source === source);
      if (existing) {
        const updated: StoredSeenBatch = {
          ...existing,
          increments: mergeIncrement(existing.increments, pair, delta),
        };
        await storage.put(updated);
      } else {
        const created: StoredSeenBatch = {
          id: crypto.randomUUID(),
          destination: current.destination,
          source,
          increments: mergeIncrement([], pair, delta),
          attempts: 0,
        };
        await storage.put(created);
      }
      const updatedBatches = await matchingBatches(current.destination);
      let sum = 0;
      for (const batch of updatedBatches) {
        for (const item of batch.increments) sum += item.delta;
      }
      return { totalPending: sum, updatedBatches };
    });
    if (closed || backend?.persistent !== current) return;
    emitStatus(deriveSeenSyncStatus(updatedBatches, now()));
    if (totalPending >= flushThreshold) schedule(0);
    else scheduleAt(now() + flushDelayMs);
  }

  async function retarget(operation: CardOperation): Promise<void> {
    const current = backend?.persistent;
    if (closed || !current || operation.action === 'add' || isUnchangedEdit(operation)) return;
    const updatedBatches = await enqueueStorage(async () => {
      const batches = await matchingBatches(current.destination);
      for (const batch of batches) {
        if (batch.source !== operation.source) continue;
        const increments = retargetIncrements(batch.increments, operation);
        if (!increments.length) {
          await storage.remove(batch.id);
        } else {
          await storage.put({ ...batch, increments });
        }
      }
      return matchingBatches(current.destination);
    });
    if (!closed && backend?.persistent === current && !flushing) {
      emitStatus(deriveSeenSyncStatus(updatedBatches, now()));
    }
  }

  async function applyFlushSuccess(batchId: string, snapshot: ReadonlyArray<SeenIncrement>): Promise<void> {
    await enqueueStorage(async () => {
      const items = await storage.list();
      const latest = items.find(item => item.id === batchId);
      if (!latest) return;
      const remaining = subtractIncrements(latest.increments, snapshot);
      if (!remaining.length) {
        await storage.remove(batchId);
        return;
      }
      const updated: StoredSeenBatch = {
        id: latest.id,
        destination: latest.destination,
        source: latest.source,
        increments: remaining,
        attempts: 0,
      };
      await storage.put(updated);
    });
  }

  async function applyFlushFailure(batchId: string, error: unknown): Promise<void> {
    await enqueueStorage(async () => {
      const items = await storage.list();
      const latest = items.find(item => item.id === batchId);
      if (!latest) return;
      const retryAt = seenRetryDeadline(error, latest.attempts, now(), random());
      await storage.put({
        ...latest,
        attempts: latest.attempts + 1,
        retryAt,
      });
    });
  }

  async function work(): Promise<void> {
    const current = backend;
    const executor = current?.persistent;
    if (closed || !executor?.flushSeen) return;
    if (callbacks.isBusy?.()) {
      schedule(1000);
      const deferred = await enqueueStorage(() => matchingBatches(executor.destination));
      if (!closed && backend === current) {
        emitStatus(deriveSeenSyncStatus(deferred, now()));
      }
      return;
    }

    const batches = await enqueueStorage(() => matchingBatches(executor.destination));
    if (closed || backend !== current) return;

    const currentTime = now();
    const ready = batches.filter(batch => batch.retryAt === undefined || batch.retryAt <= currentTime);
    if (ready.length > 0) {
      flushing = true;
      emitStatus({ kind: 'saving' });
    }
    try {
      for (const batch of ready) {
        if (closed || backend !== current || callbacks.isBusy?.()) break;
        const snapshot = structuredClone(batch.increments);
        try {
          const revision = await executor.flushSeen(batch.source, snapshot);
          await applyFlushSuccess(batch.id, snapshot);
          if (backend === current) {
            callbacks.onFlush?.(batch.source, revision);
          }
        } catch (error) {
          // Intentionally silence seen-count flush errors and retry persistently in the
          // background with capped exponential backoff; seen tracking must never interrupt
          // practice or surface as a failed card mutation.
          await applyFlushFailure(batch.id, error);
        }
      }
    } finally {
      flushing = false;
    }

    if (closed || backend !== current) return;
    const remaining = await enqueueStorage(() => matchingBatches(executor.destination));
    if (closed || backend !== current) return;
    const checkTime = now();
    emitStatus(deriveSeenSyncStatus(remaining, checkTime));
    if (!remaining.length) return;

    let earliest: number | null = null;
    for (const batch of remaining) {
      if (batch.retryAt === undefined || batch.retryAt <= checkTime) {
        schedule(0);
        return;
      }
      earliest = earliest === null ? batch.retryAt : Math.min(earliest, batch.retryAt);
    }
    if (earliest !== null) scheduleAt(earliest);
  }

  async function pump(): Promise<void> {
    if (running) {
      wakeRequested = true;
      return;
    }
    if (closed || !backend?.persistent?.flushSeen) return;
    running = true;
    try {
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request(MUTATION_LOCK, { ifAvailable: true }, async lock => {
          if (lock) await work();
          else schedule(1000);
        });
      } else {
        await work();
      }
    } finally {
      running = false;
      if (wakeRequested) {
        wakeRequested = false;
        schedule(0);
      }
    }
  }

  function setBackend(next: DeckBackend | undefined): void {
    backend = next;
    clearSchedule();
    if (next?.persistent?.flushSeen && !closed) {
      void pump();
    } else {
      emitStatus({ kind: 'idle' });
    }
  }

  function wake(): void {
    if (!closed && backend?.persistent?.flushSeen) {
      void pump();
    }
  }

  function close(): void {
    closed = true;
    clearSchedule();
  }

  return { record, retarget, setBackend, wake, close };
}
