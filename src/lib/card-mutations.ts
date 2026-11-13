import type { Card, DeckState } from './types';

export function cardPosition(deck: DeckState, card: Card): number {
  const index = deck.cards.filter(item => item.source === card.source).findIndex(item => item.id === card.id);
  if (index < 0) throw new Error('Displayed card is absent from its snapshot.');
  return index;
}
