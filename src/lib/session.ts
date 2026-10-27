import type { Card } from './types';

export type PracticeSession = { order: Card[]; index: number; revealed: boolean };

export function filterCards(cards: Card[], source: string): Card[] {
  return cards.filter(card => !source || card.source === source);
}

export function shuffleCards(cards: Card[]): Card[] {
  const shuffled = [...cards];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function assertUniqueCards(cards: Card[]): void {
  if (new Set(cards.map(card => card.id)).size !== cards.length) {
    throw new Error('Practice session invariant violated: duplicate card IDs.');
  }
}

function assertSession(session: PracticeSession): void {
  const { order, index } = session;
  if (!Number.isInteger(index) || (order.length ? index < 0 || index >= order.length : index !== 0)) {
    throw new Error(`Practice session invariant violated: index ${index}, card count ${order.length}.`);
  }
  assertUniqueCards(order);
}

export function startSession(cards: Card[]): PracticeSession {
  const session = { order: shuffleCards(cards), index: 0, revealed: false };
  assertSession(session);
  return session;
}

function partitionCards(order: Card[], cards: Card[]): { retained: Card[]; added: Card[] } {
  assertUniqueCards(cards);
  const byId = new Map(cards.map(card => [card.id, card]));
  const retained: Card[] = [];
  for (const card of order) {
    const replacement = byId.get(card.id);
    if (replacement) retained.push(replacement);
  }
  const retainedIds = new Set(retained.map(card => card.id));
  return { retained, added: cards.filter(card => !retainedIds.has(card.id)) };
}

export function reconcileSession(previous: PracticeSession, cards: Card[]): PracticeSession {
  assertSession(previous);
  const { retained, added } = partitionCards(previous.order, cards);
  const current = previous.order[previous.index];
  const order = [...retained, ...shuffleCards(added)];
  const position = current ? order.findIndex(card => card.id === current.id) : -1;
  // Removal of the current card explicitly starts at the first remaining card.
  return { order, index: position === -1 ? 0 : position, revealed: position === -1 ? false : previous.revealed };
}

export function moveSession(previous: PracticeSession, delta: -1 | 1): PracticeSession {
  assertSession(previous);
  const index = previous.index + delta;
  // Navigating past the first/last card is an ordinary user action.
  if (index < 0 || index >= previous.order.length) return previous;
  return { ...previous, index, revealed: false };
}

// The single practice action reveals first, then advances; a finished round reshuffles.
export function advancePractice(previous: PracticeSession): PracticeSession {
  assertSession(previous);
  if (!previous.order.length) throw new Error('Cannot advance an empty practice session.');
  if (!previous.revealed) return { ...previous, revealed: true };
  if (previous.index === previous.order.length - 1) return startSession(previous.order);
  return moveSession(previous, 1);
}

export function hideAnswer(previous: PracticeSession): PracticeSession {
  assertSession(previous);
  if (!previous.order.length) throw new Error('Cannot hide an answer in an empty practice session.');
  return { ...previous, revealed: false };
}

export function previousQuestion(previous: PracticeSession): PracticeSession {
  assertSession(previous);
  if (previous.index === 0) return previous;
  return { ...previous, index: previous.index - 1, revealed: true };
}

// In-app operations retain round order; only removal of the current card changes focus.
export function updateSession(previous: PracticeSession, cards: Card[]): PracticeSession {
  assertSession(previous);
  const { retained, added } = partitionCards(previous.order, cards);
  const current = previous.order[previous.index];
  const order = [...retained, ...added];
  const position = current ? order.findIndex(card => card.id === current.id) : -1;
  const index = position >= 0 ? position : (order.length ? Math.min(previous.index, order.length - 1) : 0);
  const result = { order, index, revealed: position >= 0 ? previous.revealed : false };
  assertSession(result);
  return result;
}
