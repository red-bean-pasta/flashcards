import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMutationQueue, sourceSnapshot } from '../src/lib/mutation-queue.ts';
import { DeckRequestError } from '../src/lib/deck-client.ts';
import { GraphError } from '../src/lib/onedrive/graph.ts';
import type { DeckBackend } from '../src/lib/deck-backend.ts';
import type { StoredMutation } from '../src/lib/mutation-storage.ts';

Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { async request(_name: string, options: unknown, callback?: (lock: object) => Promise<void>) { await (callback ?? options as (lock: object) => Promise<void>)({}); } } } });
const deck = { cards: [], files: [], errors: [], revisions: {} };
const destination = (driveId: string) => ({ provider: 'onedrive' as const, driveId, folderId: 'folder' });
function item(id: string): StoredMutation {
  const request = { action: 'add' as const, source: 'cards.md', revision: null, question: id, answer: 'Answer' };
  return { id, createdAt: 1, destination: destination('account-a'), request, operation: { action: 'add', source: 'cards.md', replacement: { question: id, answer: 'Answer' } }, snapshot: deck, stage: 'queued', attempts: 0 };
}
function storageFixture() {
  const map = new Map<string, StoredMutation>();
  let order = 0;
  return { map, async list() { return [...map.values()].map(value => structuredClone(value)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); },
    async enqueue(value: StoredMutation) { value.order = ++order; map.set(value.id, structuredClone(value)); },
    async put(value: StoredMutation) { map.set(value.id, structuredClone(value)); }, async remove(id: string) { map.delete(id); } };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for queue'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function harness(storage: ReturnType<typeof storageFixture>) {
  const errors: unknown[] = [];
  const completed: string[] = [];
  let active: string | null = null;
  const queue = createMutationQueue({ onChange(_items, id) { active = id; }, onError(error) { errors.push(error); }, deck: () => structuredClone(deck), async onComplete(value) { completed.push(value.id); } }, storage);
  return { queue, errors, completed, active: () => active };
}
function backend(drive: string, execute: NonNullable<DeckBackend['persistent']>['execute']): DeckBackend {
  return { load: async () => deck, mutate: async () => deck, persistent: { destination: destination(drive), execute } };
}

test('review blocks later work and dismissal resumes the persisted FIFO', async () => {
  const storage = storageFixture();
  const h = harness(storage);
  const calls: string[] = [];
  h.queue.setBackend(backend('account-a', async value => { calls.push(value.id); if (value.id === 'first') throw new DeckRequestError('Needs review'); return deck; }));
  await h.queue.enqueue(item('first'));
  await h.queue.enqueue(item('second'));
  await until(() => storage.map.get('first')?.review === true && !h.active());
  assert.deepEqual(calls, ['first']);
  await h.queue.discard('first');
  await until(() => h.completed.includes('second'));
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(storage.map.size, 0);
  assert.deepEqual(h.errors, []);
  h.queue.close();
});

test('reload resumes only the matching account and respects a saved Retry-After deadline', async () => {
  const storage = storageFixture();
  const first = harness(storage);
  first.queue.setBackend(backend('account-a', async () => { throw new GraphError('throttled', { status: 429, code: 'throttled', retryAfter: '30' }); }));
  await first.queue.enqueue(item('saved'));
  await until(() => !!storage.map.get('saved')?.retryAt);
  const deadline = storage.map.get('saved')!.retryAt!;
  assert.ok(deadline >= Date.now() + 29_000);
  first.queue.close();
  const second = harness(storage);
  let calls = 0;
  second.queue.setBackend(backend('account-b', async () => { calls++; return deck; }));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 0);
  second.queue.setBackend(backend('account-a', async () => { calls++; return deck; }));
  second.queue.wake();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 0);
  assert.equal(storage.map.get('saved')!.retryAt, deadline);
  second.queue.close();
});

test('reconnecting the matching destination resumes an authorization-blocked operation', async () => {
  const storage = storageFixture();
  const h = harness(storage);
  let calls = 0;
  const connected = backend('account-a', async () => {
    if (++calls === 1) throw new DeckRequestError('Reconnect', { cause: new GraphError('Unauthorized', { status: 401, code: 'auth' }) });
    return deck;
  });
  h.queue.setBackend(connected);
  await h.queue.enqueue(item('auth'));
  await until(() => storage.map.get('auth')?.reconnect === true && !h.active());
  h.queue.setBackend(backend('different-account', async () => { throw new Error('Wrong account'); }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  h.queue.setBackend(connected);
  await until(() => h.completed.includes('auth'));
  assert.equal(calls, 2);
  assert.deepEqual(h.errors, []);
  h.queue.close();
});

test('submission ordering does not depend on the clock or queue instance', async () => {
  const storage = storageFixture();
  const first = harness(storage);
  const second = harness(storage);
  const earlier = item('earlier'); earlier.createdAt = 2000;
  const later = item('later'); later.createdAt = 1000;
  await first.queue.enqueue(earlier);
  await second.queue.enqueue(later);
  assert.deepEqual((await storage.list()).map(value => value.id), ['earlier', 'later']);
  first.queue.close(); second.queue.close();
});

test('persisted snapshots contain only the affected source', () => {
  const card = (source: string) => ({ id: source, source, line: 1, question: 'Q', answer: 'A', questionHtml: 'Q', answerHtml: 'A' });
  const full = { cards: [card('a.md'), card('b.md')], files: ['a.md', 'b.md'], revisions: { 'a.md': '1', 'b.md': '2' }, errors: [] };
  assert.deepEqual(sourceSnapshot(full, 'a.md'), { cards: [card('a.md')], files: ['a.md'], revisions: { 'a.md': '1' }, errors: [] });
});

test('retry after queue deletion failure does not project the completed change again', async () => {
  const storage = storageFixture();
  const remove = storage.remove;
  let fail = true;
  storage.remove = async id => {
    if (fail) { fail = false; throw new Error('IndexedDB deletion failed'); }
    await remove(id);
  };
  const h = harness(storage);
  h.queue.setBackend(backend('account-a', async (value, checkpoint) => {
    value.stage = 'releasing';
    await checkpoint(value);
    return deck;
  }));
  await h.queue.enqueue(item('added'));
  await until(() => storage.map.get('added')?.review === true && !h.active());
  assert.deepEqual(h.completed, ['added']);
  await h.queue.reviewAgain('added');
  await until(() => !storage.map.has('added') && !h.active());
  assert.deepEqual(h.completed, ['added']);
  h.queue.close();
});
