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

function assertSession(session: PracticeSession): void {
  const { order, index } = session;
  if (!Number.isInteger(index) || (order.length ? index < 0 || index >= order.length : index !== 0)) {
    throw new Error(`Practice session invariant violated: index ${index}, card count ${order.length}.`);
  }
  if (new Set(order.map(card => card.id)).size !== order.length) {
    throw new Error('Practice session invariant violated: duplicate card IDs.');
  }
}

export function startSession(cards: Card[]): PracticeSession {
  const session = { order: shuffleCards(cards), index: 0, revealed: false };
  assertSession(session);
  return session;
}

function retainExistingCards(order: Card[], cards: Card[]): Card[] {
  const byId = new Map(cards.map(card => [card.id, card]));
  const retained: Card[] = [];
  for (const card of order) {
    const replacement = byId.get(card.id);
    if (replacement) retained.push(replacement);
  }
  return retained;
}

function mergeNewCards(order: Card[], cards: Card[]): Card[] {
  const retained = retainExistingCards(order, cards);
  const retainedIds = new Set(retained.map(card => card.id));
  return [...retained, ...shuffleCards(cards.filter(card => !retainedIds.has(card.id)))];
}

export function reconcileSession(previous: PracticeSession, cards: Card[]): PracticeSession {
  assertSession(previous);
  if (new Set(cards.map(card => card.id)).size !== cards.length) {
    throw new Error('Cannot reconcile a deck with duplicate card IDs.');
  }
  const current = previous.order[previous.index];
  const order = mergeNewCards(previous.order, cards);
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
