import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeckRequestError, fetchDeck } from '../src/lib/deck-client.ts';
import { createDeckSync } from '../src/lib/deck-sync.ts';
import type { DeckState } from '../src/lib/types.ts';

const deck: DeckState = { cards: [], files: [], errors: [], revisions: {}, updatedAt: 'now' };
const callbacks = () => ({ onDeck(_deck: DeckState) {}, onError(_message: string) {}, onLoading(_loading: boolean) {} });

test('snapshot loader requests data only on explicit refresh', async () => {
  let requests = 0;
  let external = { ...deck, updatedAt: 'initial' };
  const received: DeckState[] = [];
  const sync = createDeckSync({ ...callbacks(), onDeck: value => received.push(value) }, async () => {
    requests++;
    return external;
  });
  assert.equal(requests, 0);
  await sync.refresh();
  external = { ...deck, updatedAt: 'external edit' };
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests, 1);
  assert.deepEqual(received.map(value => value.updatedAt), ['initial']);
  await sync.refresh();
  assert.deepEqual(received.map(value => value.updatedAt), ['initial', 'external edit']);
  sync.close();
});

test('HTTP, malformed JSON, invalid shapes and network failures are explicit request errors', async () => {
  for (const response of [new Response('error', { status: 503 }), new Response('{'), Response.json({ cards: 'wrong' })]) {
    await assert.rejects(fetchDeck(async () => response), DeckRequestError);
  }
  const cause = new TypeError('Network disconnected');
  await assert.rejects(fetchDeck(async () => { throw cause; }), error => error instanceof DeckRequestError && error.cause === cause);
  assert.deepEqual(await fetchDeck(async () => Response.json(deck)), deck);
});

test('unexpected transport errors and consumed-body contract failures propagate unchanged', async () => {
  const failure = new Error('Unexpected transport bug');
  await assert.rejects(fetchDeck(async () => { throw failure; }), error => error === failure);
  const response = Response.json(deck);
  await response.json();
  await assert.rejects(fetchDeck(async () => response), error => error instanceof TypeError && !(error instanceof DeckRequestError));
});

test('sync recovers only request errors; reconciliation failures retain identity and cause', async () => {
  let diagnostic = '';
  const hooks = { ...callbacks(), onError(message: string) { diagnostic = message; } };
  const recoverable = createDeckSync(hooks, async () => { throw new DeckRequestError('offline'); });
  await recoverable.refresh();
  assert.equal(diagnostic, 'offline');
  recoverable.close();
  diagnostic = '';
  const bug = new TypeError('Broken session invariant', { cause: new Error('root bug') });
  const broken = createDeckSync({ ...hooks, onDeck() { throw bug; } }, async () => deck);
  await assert.rejects(broken.refresh(), error => error === bug);
  assert.equal(diagnostic, '');
  broken.close();
  const requestBug = createDeckSync(hooks, async () => { throw bug; });
  await assert.rejects(requestBug.refresh(), error => error === bug);
  requestBug.close();
});

test('sync ignores stale responses and responses after unmount', async () => {
  const requests: Array<(deck: DeckState) => void> = [];
  const received: DeckState[] = [];
  const sync = createDeckSync({ ...callbacks(), onDeck: deck => received.push(deck) },
    () => new Promise(resolve => requests.push(resolve)));
  const first = sync.refresh();
  const second = sync.refresh();
  requests[1]({ ...deck, updatedAt: 'new' });
  await second;
  requests[0]({ ...deck, updatedAt: 'old' });
  await first;
  assert.deepEqual(received.map(deck => deck.updatedAt), ['new']);
  const last = sync.refresh();
  sync.close();
  requests[2]({ ...deck, updatedAt: 'after-close' });
  await last;
  assert.equal(received.length, 1);
  await assert.rejects(sync.refresh(), /closed/);
});

test('mutation transport preserves explicit conflicts and rejects invalid success shapes', async () => {
  const { submitMutation } = await import('../src/lib/deck-client.ts');
  const request = { action: 'add' as const, source: 'default.md', revision: null, question: 'Q', answer: 'A' };
  await assert.rejects(submitMutation(request, async () => Response.json({ error: 'Refresh first' }, { status: 409 })), /Refresh first/);
  await assert.rejects(submitMutation(request, async () => Response.json({ source: 'wrong.md', revision: 'r', cards: [] })), /invalid save response/);
  const bug = new Error('Internal transport defect', { cause: new Error('root cause') });
  await assert.rejects(submitMutation(request, async () => { throw bug; }), error => error === bug);
  await assert.rejects(submitMutation(request, async () => { throw new TypeError('offline'); }), /outcome is unknown/);
});
