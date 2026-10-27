import type { Card, DeckState, MutationRequest, MutationResult } from './types';

export function sourceLabel(source: string): string {
  return source.replace(/\.md$/i, '').split('/').map(part =>
    part.replace(/[_-]+/g, ' ').replace(/\b\p{L}/gu, letter => letter.toUpperCase())).join(' / ');
}

export function newSource(label: string): string {
  const name = label.trim().replace(/\.md$/i, '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  if (!name) throw new Error('A validated file name must contain a letter or number.');
  return `${name}.md`;
}

export function cardPosition(deck: DeckState, card: Card): number {
  const index = deck.cards.filter(item => item.source === card.source).findIndex(item => item.id === card.id);
  if (index < 0) throw new Error('Displayed card is absent from its snapshot.');
  return index;
}

export function applyMutation(deck: DeckState, request: MutationRequest, result: MutationResult): DeckState {
  const previous = deck.cards.filter(card => card.source === result.source);
  const expectedCount = previous.length + (request.action === 'add' ? 1 : request.action === 'remove' ? -1 : 0);
  if (result.source !== request.source || result.cards.length !== expectedCount) {
    throw new Error('Mutation response contract violated: source or card count mismatch.');
  }
  const retained = request.action === 'remove' ? previous.filter((_, index) => index !== request.index) : previous;
  const cards = result.cards.map((card, index) => {
    const existing = retained[index];
    if (existing) return { ...card, id: existing.id };
    if (request.action !== 'add' || index !== previous.length) throw new Error('Mutation identity mapping is incomplete.');
    return { ...card, id: crypto.randomUUID() };
  });
  return {
    ...deck,
    cards: [...deck.cards.filter(card => card.source !== result.source), ...cards],
    files: [...new Set([...deck.files, result.source])].sort(),
    revisions: { ...deck.revisions, [result.source]: result.revision },
  };
}
