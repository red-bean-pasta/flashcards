import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeenQueue, deriveSeenSyncStatus, incrementDeckSeen, seenRetryDeadline, type SeenStorage, type SeenSyncStatus } from '../src/lib/seen-queue.ts';
import type { StoredSeenBatch } from '../src/lib/seen-storage.ts';
import type { DeckBackend } from '../src/lib/deck-backend.ts';
import type { SeenIncrement } from '../src/lib/onedrive/operations.ts';
import { GraphError } from '../src/lib/onedrive/graph.ts';
import type { DeckState } from '../src/lib/types.ts';

function storageFixture(): SeenStorage & { map: Map<string, StoredSeenBatch> } {
  const map = new Map<string, StoredSeenBatch>();
  return {
    map,
    async list() {
      return [...map.values()].map(value => structuredClone(value));
    },
    async put(item) {
      map.set(item.id, structuredClone(item));
    },
    async remove(id) {
      map.delete(id);
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for seen queue.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function makeBackend(
  driveId: string,
  flushSeen: (source: string, increments: ReadonlyArray<SeenIncrement>) => Promise<string | null>,
): DeckBackend {
  const empty: DeckState = { cards: [], files: [], errors: [], revisions: {} };
  return {
    load: async () => empty,
    mutate: async () => empty,
    persistent: {
      destination: { provider: 'onedrive', driveId, folderId: 'root' },
      execute: async () => empty,
      flushSeen,
    },
  };
}

test('seenQueue batches per file, flushes on delay, and flushes immediately at threshold', async () => {
  const storage = storageFixture();
  const flushes: Array<{ source: string; increments: SeenIncrement[] }> = [];
  const updatedRevisions: Array<string | null> = [];
  const queue = createSeenQueue(
    { onFlush: (_source, rev) => { updatedRevisions.push(rev); } },
    storage,
    { flushDelayMs: 25, flushThreshold: 3 },
  );
  queue.setBackend(makeBackend('drive-a', async (source, increments) => {
    flushes.push({ source, increments: structuredClone(increments) as SeenIncrement[] });
    return 'rev-1';
  }));

  await queue.record('a.md', { question: 'Q1', answer: 'A1' });
  await queue.record('a.md', { question: 'Q1', answer: 'A1' });
  assert.equal(flushes.length, 0);

  // Threshold of 3 total increments triggers an immediate flush in one batch.
  await queue.record('a.md', { question: 'Q2', answer: 'A2' });
  await until(() => flushes.length === 1 && storage.map.size === 0);
  assert.deepEqual(flushes[0], {
    source: 'a.md',
    increments: [
      { question: 'Q1', answer: 'A1', delta: 2 },
      { question: 'Q2', answer: 'A2', delta: 1 },
    ],
  });
  assert.deepEqual(updatedRevisions, ['rev-1']);

  // Below threshold still flushes once flushDelayMs elapses.
  await queue.record('b.md', { question: 'Q3', answer: 'A3' });
  await until(() => flushes.length === 2 && storage.map.size === 0);
  assert.deepEqual(flushes[1], {
    source: 'b.md',
    increments: [{ question: 'Q3', answer: 'A3', delta: 1 }],
  });
  queue.close();
});

test('in-flight seen records during a flush are preserved after the active flush commits', async () => {
  const storage = storageFixture();
  let releaseFlush!: () => void;
  const gate = new Promise<void>(resolve => { releaseFlush = resolve; });
  const calls: SeenIncrement[][] = [];

  const queue = createSeenQueue({}, storage, { flushDelayMs: 1000, flushThreshold: 1 });
  queue.setBackend(makeBackend('drive-a', async (_source, increments) => {
    calls.push(structuredClone(increments) as SeenIncrement[]);
    if (calls.length === 1) await gate;
    return `rev-${calls.length}`;
  }));

  await queue.record('deck.md', { question: 'Q1', answer: 'A1' });
  await until(() => calls.length === 1);

  // User reveals the same card again (or another round starts) while the first flush is in flight.
  await queue.record('deck.md', { question: 'Q1', answer: 'A1' });
  releaseFlush();

  await until(() => calls.length === 2 && storage.map.size === 0);
  assert.deepEqual(calls[0], [{ question: 'Q1', answer: 'A1', delta: 1 }]);
  assert.deepEqual(calls[1], [{ question: 'Q1', answer: 'A1', delta: 1 }]);
  queue.close();
});

test('seenQueue silences flush errors, retries persistently with capped exponential backoff, and never quits', async () => {
  const storage = storageFixture();
  let clock = 10_000;
  let attempts = 0;
  let succeed = false;

  const queue = createSeenQueue({}, storage, {
    flushDelayMs: 100,
    flushThreshold: 1,
    now: () => clock,
    random: () => 0,
  });
  queue.setBackend(makeBackend('drive-a', async () => {
    attempts++;
    if (!succeed) throw new GraphError('Offline', { status: 0, code: 'networkError' });
    return 'rev-ok';
  }));

  await queue.record('deck.md', { question: 'Q1', answer: 'A1' });
  await until(() => attempts === 1 && [...storage.map.values()][0]?.attempts === 1);

  let batch = [...storage.map.values()][0]!;
  assert.equal(batch.retryAt, clock + 2000);

  // Before retryAt, wake does not hammer the failing endpoint.
  clock += 1500;
  queue.wake();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(attempts, 1);

  // Once retryAt passes, retry fires and advances exponential backoff (2s -> 4s).
  clock += 500;
  queue.wake();
  await until(() => attempts === 2 && [...storage.map.values()][0]?.attempts === 2);
  batch = [...storage.map.values()][0]!;
  assert.equal(batch.retryAt, clock + 4000);

  // Recovery clears the persistent batch.
  clock += 4000;
  succeed = true;
  queue.wake();
  await until(() => attempts === 3 && storage.map.size === 0);
  queue.close();

  // Verify backoff ceiling stays well before hours (capped at 300s / 5 minutes) and honors Retry-After.
  assert.equal(seenRetryDeadline(new Error('network'), 0, 1000, 0), 3000);
  assert.equal(seenRetryDeadline(new Error('network'), 1, 1000, 0), 5000);
  assert.equal(seenRetryDeadline(new Error('network'), 2, 1000, 0), 9000);
  assert.equal(seenRetryDeadline(new Error('network'), 20, 1000, 0), 301_000);
  assert.equal(
    seenRetryDeadline(new GraphError('throttled', { status: 429, code: 'throttled', retryAfter: '400' }), 0, 1000, 0),
    401_000,
  );
  assert.throws(() => seenRetryDeadline(new Error('bad'), -1, 1000, 0), /Invalid seen retry scheduler input/);
});

test('retarget updates pending seen increments on edit and drops them on remove', async () => {
  const storage = storageFixture();
  let busy = true;
  const flushes: SeenIncrement[][] = [];
  const queue = createSeenQueue({ isBusy: () => busy }, storage, { flushDelayMs: 5000, flushThreshold: 10 });
  queue.setBackend(makeBackend('drive-a', async (_source, increments) => {
    flushes.push(structuredClone(increments) as SeenIncrement[]);
    return 'rev';
  }));

  await queue.record('deck.md', { question: 'Old Q', answer: 'Old A' });
  await queue.record('deck.md', { question: 'New Q', answer: 'New A' });
  await queue.record('deck.md', { question: 'Gone Q', answer: 'Gone A' });

  await queue.retarget({
    action: 'edit',
    source: 'deck.md',
    original: { question: 'Old Q', answer: 'Old A' },
    replacement: { question: '  New Q  ', answer: '\nNew A\n' },
  });
  await queue.retarget({
    action: 'remove',
    source: 'deck.md',
    original: { question: 'Gone Q', answer: 'Gone A' },
  });

  busy = false;
  queue.wake();
  await until(() => flushes.length === 1 && storage.map.size === 0);
  assert.deepEqual(flushes[0], [{ question: 'New Q', answer: 'New A', delta: 2 }]);

  // Removing the sole pending card removes the entire stored batch.
  busy = true;
  await queue.record('deck.md', { question: 'Only Q', answer: 'Only A' });
  assert.equal(storage.map.size, 1);
  await queue.retarget({
    action: 'remove',
    source: 'deck.md',
    original: { question: 'Only Q', answer: 'Only A' },
  });
  assert.equal(storage.map.size, 0);
  queue.close();
});

test('incrementDeckSeen updates all matching duplicate pairs in the target file only', () => {
  const card = (id: string, source: string, question: string, seen: number) => ({
    id,
    source,
    line: 1,
    question,
    answer: 'A',
    seen,
    questionHtml: question,
    answerHtml: 'A',
  });
  const deck: DeckState = {
    cards: [card('1', 'a.md', 'Q', 0), card('2', 'a.md', 'Other', 3), card('3', 'a.md', 'Q', 4), card('4', 'b.md', 'Q', 2)],
    files: ['a.md', 'b.md'],
    errors: [],
    revisions: { 'a.md': '1', 'b.md': '1' },
  };
  const updated = incrementDeckSeen(deck, 'a.md', { question: 'Q', answer: 'A' });
  assert.deepEqual(updated.cards.map(item => item.seen), [1, 3, 5, 2]);
  assert.equal(deck.cards[0].seen, 0);
});

test('deriveSeenSyncStatus distinguishes idle, saving, and earliest retrying batch', () => {
  const destination = { provider: 'onedrive' as const, driveId: 'd', folderId: 'root' };
  const batch = (id: string, retryAt?: number): StoredSeenBatch => ({
    id,
    destination,
    source: `${id}.md`,
    increments: [{ question: 'Q', answer: 'A', delta: 1 }],
    attempts: retryAt === undefined ? 0 : 1,
    ...(retryAt !== undefined ? { retryAt } : {}),
  });

  assert.deepEqual(deriveSeenSyncStatus([], 1000), { kind: 'idle' });
  assert.deepEqual(deriveSeenSyncStatus([batch('a')], 1000), { kind: 'saving' });
  assert.deepEqual(deriveSeenSyncStatus([batch('a', 5000), batch('b')], 1000), { kind: 'saving' });
  assert.deepEqual(deriveSeenSyncStatus([batch('a', 1000)], 1000), { kind: 'saving' });
  assert.deepEqual(deriveSeenSyncStatus([batch('a', 8000), batch('b', 4000)], 1000), { kind: 'retrying', retryAt: 4000 });
});

test('seenQueue emits saving, retrying, and idle status transitions', async () => {
  const storage = storageFixture();
  const statuses: SeenSyncStatus[] = [];
  let shouldFail = true;
  let nowMs = 10_000;

  const queue = createSeenQueue(
    { onStatusChange: status => { statuses.push(status); } },
    storage,
    { flushDelayMs: 20, flushThreshold: 2, now: () => nowMs, random: () => 0 },
  );
  try {
    queue.setBackend(makeBackend('drive-a', async () => {
      if (shouldFail) throw new GraphError('offline', 0, 'networkError');
      return 'rev-2';
    }));

    // Debouncing a single increment enters saving immediately, then transitions to retrying on failure.
    await queue.record('a.md', { question: 'Q1', answer: 'A1' });
    assert.deepEqual(statuses.at(-1), { kind: 'saving' });

    await until(() => statuses.at(-1)?.kind === 'retrying');
    const retryStatus = statuses.at(-1);
    assert.equal(retryStatus?.kind, 'retrying');
    assert.ok(retryStatus.kind === 'retrying' && retryStatus.retryAt >= nowMs + 2000);

    // Advancing past the retry deadline and succeeding returns to idle.
    shouldFail = false;
    nowMs = retryStatus.retryAt;
    queue.wake();
    await until(() => statuses.at(-1)?.kind === 'idle' && storage.map.size === 0);
    assert.deepEqual(statuses.map(s => s.kind), ['saving', 'retrying', 'saving', 'idle']);

    // Disconnecting while a batch is pending resets reported status to idle.
    shouldFail = true;
    await queue.record('a.md', { question: 'Q2', answer: 'A2' });
    assert.deepEqual(statuses.at(-1), { kind: 'saving' });
    queue.setBackend(undefined);
    assert.deepEqual(statuses.at(-1), { kind: 'idle' });
  } finally {
    queue.close();
  }
});
