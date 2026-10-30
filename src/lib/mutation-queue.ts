import type { DeckBackend } from './deck-backend.js';
import { DeckRequestError } from './deck-client.js';
import { samePair } from './onedrive/operations.js';
import { requiresReconnect, retryDecision, serviceRetryDeadline } from './mutation-retry.js';
import { mutationStorage, sameDestination, type MutationStage, type StoredMutation } from './mutation-storage.js';
import type { DeckState } from './types.js';

export type QueueActivity = 'applying' | 'retrying' | 'reviewing' | null;
export function sourceSnapshot(deck: DeckState, source: string): DeckState {
  const revision = deck.revisions[source];
  return { cards: deck.cards.filter(card => card.source === source), files: deck.files.filter(file => file === source), errors: [...deck.errors], revisions: revision === undefined ? {} : { [source]: revision } };
}
type Storage = Pick<typeof mutationStorage, 'list' | 'put' | 'remove' | 'enqueue'>;
interface QueueCallbacks {
  onChange(items: StoredMutation[], activeId: string | null, activity: QueueActivity, matched: string[]): void;
  onComplete(item: StoredMutation, deck: DeckState, resumed: boolean, startedAt: MutationStage): Promise<void>;
  onError(error: unknown): void;
  deck(): DeckState;
}

/** One persisted FIFO per destination. The browser lock prevents two tabs replaying it. */
export function createMutationQueue(callbacks: QueueCallbacks, storage: Storage = mutationStorage) {
  let backend: DeckBackend | undefined;
  let items: StoredMutation[] = [];
  let activeId: string | null = null;
  let activity: QueueActivity = null;
  let running = false;
  let wakeRequested = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let matched: string[] = [];
  let reconnectPending = false;
  const fresh = new Set<string>();
  const projected = new Set<string>();
  let submission = Promise.resolve();

  function notify() { callbacks.onChange([...items], activeId, activity, [...matched]); }
  async function refresh() {
    items = await storage.list();
    const current = backend;
    const result: string[] = [];
    if (current?.persistent) for (const item of items) if (await sameDestination(item.destination, current.persistent.destination)) result.push(item.id);
    if (current === backend) matched = result;
    notify();
  }
  function schedule(ms: number) {
    clearTimeout(timer);
    if (!closed) timer = setTimeout(() => { void pump(); }, Math.max(0, Math.min(ms, 2_147_483_647)));
  }
  async function checkpoint(item: StoredMutation) {
    await storage.put(item);
    if (activeId === item.id && (item.stage === 'archive-writing' || item.stage === 'source-writing')) activity = item.attempts || !fresh.has(item.id) ? 'retrying' : 'applying';
    items = items.map(existing => existing.id === item.id ? { ...item } : existing);
    notify();
  }

  async function currentItem(): Promise<StoredMutation | undefined> {
    const destination = backend?.persistent?.destination;
    if (!destination) return undefined;
    for (const item of items) if (await sameDestination(item.destination, destination)) return item;
    return undefined;
  }

  async function prepareQueued(item: StoredMutation) {
    if (item.stage !== 'queued' && item.stage !== 'preparing') return;
    const deck = callbacks.deck();
    if (item.operation.action !== 'add') {
      const original = item.operation.original;
      if (!original || !deck.cards.some(card => card.source === item.operation.source && samePair(card, original))) {
        throw new DeckRequestError('This card changed or was removed before the queued change could be applied.');
      }
    }
    item.snapshot = structuredClone(sourceSnapshot(deck, item.operation.source));
    await checkpoint(item);
  }

  async function processItem(item: StoredMutation, current: DeckBackend) {
    const executor = current.persistent;
    if (!executor) throw new Error('Persistent queue requires a writable backend.');
    activeId = item.id;
    activity = item.stage === 'queued' || item.stage === 'preparing' ? (item.attempts ? 'retrying' : 'applying') : 'reviewing';
    notify();
    const startedAt = item.stage;
    try {
      await prepareQueued(item);
      const resumed = !fresh.has(item.id);
      const deck = await executor.execute(item, checkpoint, resumed);
      if (!projected.has(item.id)) {
        await callbacks.onComplete(item, deck, resumed, startedAt);
        projected.add(item.id);
      }
      await storage.remove(item.id);
      fresh.delete(item.id);
      projected.delete(item.id);
    } catch (error) {
      const decision = retryDecision(error, item.attempts, Date.now(), Math.random());
      item.error = error instanceof Error ? error.message : String(error);
      if (decision.kind === 'retry') {
        item.attempts++;
        item.retryAt = decision.notBefore;
        item.review = false;
        item.retryBlocked = false;
      } else {
        item.review = true;
        const deadline = serviceRetryDeadline(error, Date.now());
        item.retryBlocked = deadline === null;
        item.reconnect = deadline !== null && requiresReconnect(error);
        if (deadline !== null && deadline > Date.now()) item.retryAt = deadline;
        else delete item.retryAt;
        if (!(error instanceof DeckRequestError)) callbacks.onError(error);
      }
      await checkpoint(item);
    } finally { activeId = null; activity = null; notify(); }
    await refresh();
  }

  async function work() {
    await refresh();
    const current = backend;
    if (!current?.persistent) return;
    if (reconnectPending) {
      reconnectPending = false;
      for (const item of items) {
        if (item.reconnect && await sameDestination(item.destination, current.persistent.destination)) {
          item.review = false;
          item.reconnect = false;
          await storage.put(item);
        }
      }
      await refresh();
      if (current !== backend) return;
    }
    const item = await currentItem();
    if (current !== backend) return;
    if (!item || item.review) return;
    if (item.retryAt && item.retryAt > Date.now()) { schedule(item.retryAt - Date.now()); return; }
    await processItem(item, current);
    if (!closed) schedule(0);
  }

  async function pump() {
    if (running) { wakeRequested = true; return; }
    if (closed || !backend?.persistent) return;
    running = true;
    try {
      if (!navigator.locks) throw new DeckRequestError('This browser cannot safely coordinate pending changes between tabs.');
      await navigator.locks.request('flashcards-mutation-queue', { ifAvailable: true }, async lock => {
        if (lock) await work();
        else schedule(2000);
      });
    } catch (error) { callbacks.onError(error); }
    finally {
      running = false;
      if (wakeRequested) { wakeRequested = false; schedule(0); }
    }
  }

  function enqueue(item: StoredMutation): Promise<void> {
    const task = submission.then(async () => {
      await storage.list();
      await storage.enqueue(item);
      fresh.add(item.id);
      try { await refresh(); } catch (error) { callbacks.onError(error); }
      void pump();
    });
    submission = task.catch(() => {});
    return task;
  }

  async function discard(id: string): Promise<void> {
    if (!backend?.persistent || activeId) throw new DeckRequestError('Connect the original folder and wait for the active save before dismissing this change.');
    const selected = backend;
    await navigator.locks.request('flashcards-mutation-queue', async () => {
      await refresh();
      const item = items.find(value => value.id === id);
      if (!item || !item.review || !selected.persistent || !await sameDestination(item.destination, selected.persistent.destination)) throw new DeckRequestError('Connect the original folder to dismiss this pending change.');
      await selected.persistent.discard?.(id);
      await storage.remove(id);
      fresh.delete(id);
      projected.delete(id);
      await refresh();
    });
    void pump();
  }

  async function reviewAgain(id: string): Promise<void> {
    if (!backend?.persistent || activeId) throw new DeckRequestError('Connect the original folder and wait for the active save.');
    const selected = backend;
    await navigator.locks.request('flashcards-mutation-queue', async () => {
      await refresh();
      const item = items.find(value => value.id === id);
      if (!item || !item.review || item.retryBlocked || !selected.persistent || !await sameDestination(item.destination, selected.persistent.destination)) throw new DeckRequestError('This change cannot be reviewed again until its original folder is connected.');
      item.review = false;
      item.reconnect = false;
      await checkpoint(item);
    });
    void pump();
  }

  function setBackend(next: DeckBackend | undefined) {
    backend = next;
    reconnectPending = !!next;
    matched = [];
    clearTimeout(timer);
    void refresh().then(pump, callbacks.onError);
  }
  function wake() { void pump(); }
  function close() { closed = true; clearTimeout(timer); }
  return { enqueue, discard, reviewAgain, setBackend, wake, close, refresh };
}
