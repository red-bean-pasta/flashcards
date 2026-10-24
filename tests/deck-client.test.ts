import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeckRequestError, fetchDeck } from '../src/lib/deck-client.ts';
import { createDeckSync } from '../src/lib/deck-sync.ts';
import type { DeckState } from '../src/lib/types.ts';

const deck: DeckState = { cards: [], files: [], errors: [], updatedAt: 'now' };
const events = () => ({ addEventListener() {}, removeEventListener() {}, close() {} });
const callbacks = () => ({ onDeck(_deck: DeckState) {}, onConnection(_status: string) {}, onError(_message: string) {}, onLoading(_loading: boolean) {} });

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
  const recoverable = createDeckSync(events(), hooks, async () => { throw new DeckRequestError('offline'); });
  await recoverable.refresh();
  assert.equal(diagnostic, 'offline');
  recoverable.close();
  diagnostic = '';
  const bug = new TypeError('Broken session invariant', { cause: new Error('root bug') });
  const broken = createDeckSync(events(), { ...hooks, onDeck() { throw bug; } }, async () => deck);
  await assert.rejects(broken.refresh(), error => error === bug);
  assert.equal(diagnostic, '');
  broken.close();
  const requestBug = createDeckSync(events(), hooks, async () => { throw bug; });
  await assert.rejects(requestBug.refresh(), error => error === bug);
  requestBug.close();
});

test('sync ignores stale responses and responses after unmount', async () => {
  const requests: Array<(deck: DeckState) => void> = [];
  const received: DeckState[] = [];
  const sync = createDeckSync(events(), { ...callbacks(), onDeck: deck => received.push(deck) },
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
