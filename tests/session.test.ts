import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advancePractice, hideAnswer, previousQuestion, startSession, reconcileSession, moveSession, updateSession } from '../src/lib/session.ts';
import { parseBrowserCards } from '../src/lib/browser-cards.ts';
const parseCards = (text: string, source: string) => parseBrowserCards(text, source, value => value);

const cards = parseCards('# question\nOne\n# answer\nA\n# question\nTwo\n# answer\nB', 'session.md');

test('snapshot loads shuffle additions and reset missing focus; mutations append and retain position', t => {
  t.mock.method(Math, 'random', () => 0);
  const [first, removed, last, addedA, addedB] = parseCards(
    ['First', 'Removed', 'Last', 'Added A', 'Added B'].map(question => `# question\n${question}\n# answer\nA`).join('\n'), 'policies.md');
  const previous = { order: [first, removed, last], index: 1, revealed: true };
  const incoming = [first, last, addedA, addedB];
  const snapshot = reconcileSession(previous, incoming);
  assert.deepEqual(snapshot.order.map(card => card.id), [first, last, addedB, addedA].map(card => card.id));
  assert.equal(snapshot.index, 0);
  assert.equal(snapshot.revealed, false);
  const mutation = updateSession(previous, incoming);
  assert.deepEqual(mutation.order, incoming);
  assert.equal(mutation.index, 1);
  assert.equal(mutation.order[mutation.index].id, last.id);
  assert.equal(mutation.revealed, false);
});

test('reconciliation retains current answer, removes deleted cards and adds new cards once', () => {
  const previous = { order: cards, index: 1, revealed: true };
  const added = parseCards('# question\nThree\n# answer\nC', 'new.md')[0];
  const updated = reconcileSession(previous, [cards[1], added]);
  assert.equal(updated.order[updated.index].id, cards[1].id);
  assert.equal(updated.revealed, true);
  assert.deepEqual(new Set(updated.order.map(card => card.id)), new Set([cards[1].id, added.id]));
  const removedCurrent = reconcileSession(previous, [cards[0]]);
  assert.equal(removedCurrent.index, 0);
  assert.equal(removedCurrent.revealed, false);
  assert.deepEqual(reconcileSession(previous, []), { order: [], index: 0, revealed: false });
});
test('navigation respects user boundaries and clears the answer on a move', () => {
  const session = { order: cards, index: 0, revealed: true };
  assert.equal(moveSession(session, -1), session);
  assert.deepEqual(moveSession(session, 1), { order: cards, index: 1, revealed: false });
  assert.deepEqual(new Set(startSession(cards).order.map(card => card.id)), new Set(cards.map(card => card.id)));
});
test('invalid session indices and duplicate IDs fail explicitly instead of resetting', () => {
  assert.throws(() => reconcileSession({ order: cards, index: 99, revealed: false }, cards), /invariant violated/);
  assert.throws(() => moveSession({ order: [], index: 1, revealed: false }, 1), /invariant violated/);
  assert.throws(() => startSession([cards[0], cards[0]]), /duplicate card IDs/);
  assert.throws(() => reconcileSession(startSession(cards), [cards[0], cards[0]]), /duplicate card IDs/);
});

test('primary action reveals, advances to an unrevealed question, and starts a new round at the end', () => {
  const initial = { order: cards, index: 0, revealed: false };
  const revealed = advancePractice(initial);
  assert.equal(revealed.index, 0);
  assert.equal(revealed.revealed, true);
  const next = advancePractice(revealed);
  assert.equal(next.index, 1);
  assert.equal(next.revealed, false);
  const restarted = advancePractice(advancePractice(next));
  assert.equal(restarted.index, 0);
  assert.equal(restarted.revealed, false);
  assert.deepEqual(new Set(restarted.order.map(card => card.id)), new Set(cards.map(card => card.id)));
  assert.throws(() => advancePractice(startSession([])), /empty practice session/);
  assert.throws(() => advancePractice({ ...initial, index: 99 }), /invariant violated/);
});

test('hide restores the same question; previous returns the preceding question with its answer', () => {
  const current = { order: cards, index: 1, revealed: true };
  const hidden = hideAnswer(current);
  assert.equal(hidden.index, 1);
  assert.equal(hidden.revealed, false);
  assert.equal(hidden.order, cards);
  for (const revealed of [true, false]) {
    const previous = previousQuestion({ ...current, revealed });
    assert.equal(previous.index, 0);
    assert.equal(previous.revealed, true);
    assert.equal(previous.order, cards);
    const next = advancePractice(previous);
    assert.equal(next.index, 1);
    assert.equal(next.revealed, false);
  }
  const first = { ...current, index: 0 };
  assert.equal(previousQuestion(first), first);
  assert.throws(() => hideAnswer(startSession([])), /empty practice session/);
  assert.throws(() => previousQuestion({ ...current, index: 99 }), /invariant violated/);
});
