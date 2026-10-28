import { parseCardRanges } from '../card-ranges.js';
import { appendEntry, formatEntry } from '../card-text.js';
import { parseBrowserCards } from '../browser-cards.js';
import { DeckRequestError } from '../deck-client.js';
import type { Card, DeckState, MutationRequest } from '../types.js';

export type Pair = { question: string; answer: string };
export type CardOperation = { source: string; original?: Pair } & (
  | { action: 'add' | 'edit'; replacement: Pair }
  | { action: 'remove' }
);
export type ContentChange = { text: string; removed: string; matched: number };

export function samePair(a: Pair, b: Pair): boolean {
  return a.question === b.question && a.answer === b.answer;
}

export function validateSource(source: string): void {
  if (!source || source.includes('\\') || source.includes('\0') || source.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !/\.md$/i.test(source) || source.split('/').at(-1)!.toLowerCase() === 'removed.md') {
    throw new DeckRequestError('Choose a Markdown file other than removed.md.');
  }
}

export function captureOperation(deck: DeckState, request: MutationRequest): CardOperation {
  validateSource(request.source);
  if (request.action === 'add') return { source: request.source, action: 'add', replacement: { question: request.question, answer: request.answer } };
  const original = deck.cards.filter(card => card.source === request.source)[request.index];
  if (!original) throw new Error('Mutation contract violated: displayed card is absent from its snapshot.');
  return request.action === 'remove'
    ? { source: request.source, action: 'remove', original }
    : { source: request.source, action: 'edit', original, replacement: { question: request.question, answer: request.answer } };
}

export function planContent(text: string, operation: CardOperation): ContentChange {
  const ranges = parseCardRanges(text, operation.source);
  const eol = text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  if (operation.action === 'add') return {
    text: appendEntry(text, formatEntry(operation.replacement.question, operation.replacement.answer, eol), eol), removed: '', matched: 0,
  };
  if (!operation.original) throw new Error('Edit/remove operations require an original pair.');
  const matches = ranges.filter(range => samePair(range.content, operation.original!));
  if (!matches.length) throw new DeckRequestError('This card was changed or removed. Your draft has been kept; refresh to review the current file.');
  const replacement = operation.action === 'edit' ? formatEntry(operation.replacement.question, operation.replacement.answer, eol) : '';
  let next = text;
  for (const range of [...matches].reverse()) next = next.slice(0, range.start) + replacement + next.slice(range.end);
  return { text: next, removed: operation.action === 'remove' ? matches.map(range => text.slice(range.start, range.end)).join('') : '', matched: matches.length };
}

/** Apply only this operation to the practice snapshot; external edits wait for refresh. */
export function projectOperation(
  deck: DeckState, operation: CardOperation, revision: string,
  parse: typeof parseBrowserCards = parseBrowserCards,
  savedText?: string,
): DeckState {
  const previous = deck.cards.filter(card => card.source === operation.source);
  let cards: Card[];
  if (operation.action === 'add') {
    const created = parse(formatEntry(operation.replacement.question, operation.replacement.answer, '\n'), operation.source);
    if (created.length !== 1) throw new Error('Add planning contract violated: expected one new card.');
    cards = [...previous, created[0]];
  } else {
    if (!operation.original) throw new Error('Edit/remove projection requires its original pair.');
    const matching = previous.filter(card => samePair(card, operation.original!));
    if (!matching.length) throw new Error('Mutation projection lost the original snapshot pair.');
    let edited: Card | undefined;
    if (operation.action === 'edit') {
      const replacement = parse(formatEntry(operation.replacement.question, operation.replacement.answer, '\n'), operation.source);
      if (replacement.length !== 1) throw new Error('Edit planning contract violated: expected one replacement card.');
      [edited] = replacement;
    }
    cards = previous.flatMap(card => !samePair(card, operation.original!) ? [card]
      : operation.action === 'remove' ? [] : [{ ...edited!, id: card.id, line: card.line }]);
  }
  if (savedText !== undefined) cards = locateSnapshotCards(cards, savedText, operation.source);
  return {
    ...deck, cards: [...deck.cards.filter(card => card.source !== operation.source), ...cards],
    files: [...new Set([...deck.files, operation.source])].sort(),
    revisions: { ...deck.revisions, [operation.source]: revision },
  };
}

function locateSnapshotCards(cards: Card[], text: string, source: string): Card[] {
  const positions = new Map<string, number[]>();
  for (const { content } of parseCardRanges(text, source)) {
    const key = JSON.stringify([content.question, content.answer]);
    const lines = positions.get(key) ?? [];
    lines.push(content.line);
    positions.set(key, lines);
  }
  return cards.map(card => {
    const line = positions.get(JSON.stringify([card.question, card.answer]))?.shift();
    // An externally edited/deleted card remains in the deliberate practice
    // snapshot until refresh; its old source annotation remains a snapshot too.
    return line === undefined || line === card.line ? card : { ...card, line };
  });
}
