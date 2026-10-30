import { archiveFilename } from '../card-text.js';
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

export function normalizedPair(pair: Pair): Pair {
  const normalize = (text: string) => text.trim().replace(/\r\n?/g, '\n');
  return { question: normalize(pair.question), answer: normalize(pair.answer) };
}

/** An unchanged edit has no storage effect and needs no recovery journal. */
export function isUnchangedEdit(operation: CardOperation): boolean {
  return operation.action === 'edit' && operation.original !== undefined && samePair(operation.original, normalizedPair(operation.replacement));
}

export function validateSource(source: string): void {
  if (!source || source.includes('\\') || source.includes('\0') || source.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !/\.md$/i.test(source) || source.split('/').at(-1)!.toLowerCase() === archiveFilename) {
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

/** A queued edit or removal must still address the same number of matching cards. */
export function validateTargets(text: string, operation: CardOperation, snapshot: DeckState): void {
  if (operation.action === 'add') return;
  if (!operation.original) throw new Error('Mutation requires an original pair.');
  const expected = snapshot.cards.filter(card => card.source === operation.source && samePair(card, operation.original!)).length;
  const actual = parseCardRanges(text, operation.source).filter(range => samePair(range.content, operation.original!)).length;
  if (!expected || actual !== expected) throw new DeckRequestError('The matching cards changed before saving. Review the pending change.');
}

function parseReplacement(operation: Extract<CardOperation, { replacement: Pair }>, parse: typeof parseBrowserCards): Card {
  const cards = parse(formatEntry(operation.replacement.question, operation.replacement.answer, '\n'), operation.source);
  if (cards.length !== 1) {
    const message = operation.action === 'add'
      ? 'Add planning contract violated: expected one new card.'
      : 'Edit planning contract violated: expected one replacement card.';
    throw new Error(message);
  }
  return cards[0];
}

function projectSourceCards(previous: Card[], operation: CardOperation, parse: typeof parseBrowserCards): Card[] {
  if (operation.action === 'add') return [...previous, parseReplacement(operation, parse)];
  const original = operation.original;
  if (!original) throw new Error('Edit/remove projection requires its original pair.');
  if (!previous.some(card => samePair(card, original))) throw new Error('Mutation projection lost the original snapshot pair.');
  if (operation.action === 'remove') return previous.filter(card => !samePair(card, original));
  const replacement = parseReplacement(operation, parse);
  return previous.map(card => samePair(card, original) ? { ...replacement, id: card.id, line: card.line } : card);
}

/** Configure rendering once for projections of this store's practice snapshot. */
export function createOperationProjector(parse: typeof parseBrowserCards = parseBrowserCards) {
  /** Apply only this operation; external edits wait for refresh. */
  return function projectOperation(deck: DeckState, operation: CardOperation, revision: string, savedText?: string): DeckState {
    const previous = deck.cards.filter(card => card.source === operation.source);
    let cards = projectSourceCards(previous, operation, parse);
    if (savedText !== undefined) cards = locateSnapshotCards(cards, savedText, operation.source);
    return {
      ...deck, cards: [...deck.cards.filter(card => card.source !== operation.source), ...cards],
      files: [...new Set([...deck.files, operation.source])].sort(),
      revisions: { ...deck.revisions, [operation.source]: revision },
    };
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
