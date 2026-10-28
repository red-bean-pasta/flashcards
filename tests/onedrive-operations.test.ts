import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBrowserCards } from '../src/lib/browser-cards.ts';
import { CardParseError, parseCardRanges } from '../src/lib/card-ranges.ts';
import { CardInputError } from '../src/lib/card-text.ts';
import { DeckRequestError } from '../src/lib/deck-client.ts';
import { captureOperation, planContent, projectOperation } from '../src/lib/onedrive/operations.ts';
import type { CardOperation } from '../src/lib/onedrive/operations.ts';
import type { DeckState } from '../src/lib/types.ts';

const entry = (question: string, answer = 'Answer') => `# question\n${question}\n\n# answer\n${answer}\n\n`;
const parse: typeof parseBrowserCards = (text, source) => parseBrowserCards(text, source, text => text);
const pair = { question: 'Same', answer: 'Answer' };
function snapshot(): DeckState {
  return {
    cards: [...parse(entry('Same') + entry('Other') + entry('Same'), 'deck.md'), ...parse(entry('Same'), 'elsewhere.md')],
    files: ['deck.md', 'elsewhere.md'], errors: ['Existing unrelated parse error'],
    revisions: { 'deck.md': 'old', 'elsewhere.md': 'unchanged' },
  };
}

test('capture uses the displayed source occurrence and rejects stale snapshot indices as internal errors', () => {
  const deck = snapshot();
  const operation = captureOperation(deck, { action: 'edit', source: 'deck.md', revision: 'old', index: 2, question: 'Changed', answer: 'New' });
  assert.equal(operation.action, 'edit');
  assert.equal(operation.original?.question, 'Same');
  assert.deepEqual(operation.action === 'edit' && operation.replacement, { question: 'Changed', answer: 'New' });
  for (const index of [-1, 3, Number.NaN]) {
    assert.throws(() => captureOperation(deck, { action: 'remove', source: 'deck.md', revision: 'old', index }),
      error => error instanceof Error && !(error instanceof DeckRequestError) && /contract violated/.test(error.message));
  }
  assert.throws(() => captureOperation(deck, { action: 'remove', source: '../escape.md', revision: null, index: 0 }), DeckRequestError);
});

test('edit and remove replace every exact pair occurrence in the selected source', () => {
  const text = entry('Same') + entry('Other') + entry('Same') + entry('Same', 'Different answer');
  const edit: CardOperation = { action: 'edit', source: 'deck.md', original: pair, replacement: { question: 'Changed', answer: 'New' } };
  assert.deepEqual(planContent(text, edit), {
    text: entry('Changed', 'New') + entry('Other') + entry('Changed', 'New') + entry('Same', 'Different answer'), removed: '', matched: 2,
  });
  assert.deepEqual(planContent(text, { action: 'remove', source: 'deck.md', original: pair }), {
    text: entry('Other') + entry('Same', 'Different answer'), removed: entry('Same') + entry('Same'), matched: 2,
  });
});

test('CRLF edit preserves untouched raw spans and removal archives exact original bytes', () => {
  const first = entry('Same').replaceAll('\n', '\r\n');
  const between = entry('Unchanged  spacing', 'Line one\n\nLine two').replaceAll('\n', '\r\n');
  const last = entry('Same').replaceAll('\n', '\r\n');
  const prefix = '---\r\n\r\n';
  const text = prefix + first + between + last;
  const edit = planContent(text, { action: 'edit', source: 'deck.md', original: pair, replacement: { question: 'Replacement\nnext line', answer: 'New' } });
  const replacement = entry('Replacement\nnext line', 'New').replaceAll('\n', '\r\n');
  assert.equal(edit.text, prefix + replacement + between + replacement);
  assert.equal(edit.text.replaceAll('\r\n', '').includes('\n'), false);
  const removed = planContent(text, { action: 'remove', source: 'deck.md', original: pair });
  assert.equal(removed.text, prefix + between);
  assert.equal(removed.removed, first + last);
  assert.equal(removed.matched, 2);
});

test('pair matching preserves internal whitespace distinctions and changed originals require refresh', () => {
  const text = entry('Two  spaces') + entry('Two spaces') + entry('Two\n\nspaces');
  const change = planContent(text, { action: 'remove', source: 'deck.md', original: { question: 'Two  spaces', answer: 'Answer' } });
  assert.equal(change.text, entry('Two spaces') + entry('Two\n\nspaces'));
  assert.equal(change.matched, 1);
  assert.throws(() => planContent(text, { action: 'remove', source: 'deck.md', original: pair }),
    error => error instanceof DeckRequestError && /changed or removed/.test(error.message));
  assert.throws(() => planContent(text, { action: 'remove', source: 'deck.md' }),
    error => error instanceof Error && !(error instanceof DeckRequestError) && /require an original/.test(error.message));
});

test('malformed source markers and marker-bearing replacement input fail explicitly', () => {
  for (const text of ['# answer\nOrphan', '# question\nNo answer', '# question\n\n# answer\nEmpty question']) {
    assert.throws(() => planContent(text, { action: 'remove', source: 'deck.md', original: pair }), CardParseError);
  }
  for (const replacement of [
    { question: 'Bad\n# answer\nInjected', answer: 'Answer' },
    { question: 'Q', answer: 'Answer\n---' },
    { question: ' ', answer: 'Answer' },
  ]) {
    assert.throws(() => planContent(entry('Same'), { action: 'edit', source: 'deck.md', original: pair, replacement }), CardInputError);
  }
});

test('snapshot editing preserves all occurrence identities and unrelated same-pair source cards', () => {
  const deck = snapshot();
  const originalCards = deck.cards.slice();
  const operation = captureOperation(deck, { action: 'edit', source: 'deck.md', revision: 'old', index: 0, question: 'Changed', answer: 'New' });
  const projected = projectOperation(deck, operation, 'saved', parse);
  const sourceCards = projected.cards.filter(card => card.source === 'deck.md');
  assert.deepEqual(sourceCards.map(card => card.question), ['Changed', 'Other', 'Changed']);
  assert.deepEqual(sourceCards.map(card => card.id), originalCards.slice(0, 3).map(card => card.id));
  assert.deepEqual(sourceCards.map(card => card.line), originalCards.slice(0, 3).map(card => card.line));
  assert.equal(projected.cards.find(card => card.source === 'elsewhere.md'), originalCards[3]);
  assert.equal(projected.cards.find(card => card.question === 'Other'), originalCards[1]);
  assert.deepEqual(projected.revisions, { 'deck.md': 'saved', 'elsewhere.md': 'unchanged' });
  assert.equal(projected.errors, deck.errors);
  assert.deepEqual(deck.cards, originalCards);
  assert.equal(deck.cards[0].question, 'Same');
});

test('snapshot removal removes all source matches while preserving other sources and remaining identities', () => {
  const deck = snapshot();
  const operation = captureOperation(deck, { action: 'remove', source: 'deck.md', revision: 'old', index: 2 });
  const projected = projectOperation(deck, operation, 'saved', parse);
  assert.equal(projected.cards.length, 2);
  assert.equal(projected.cards.find(card => card.source === 'deck.md'), deck.cards[1]);
  assert.equal(projected.cards.find(card => card.source === 'elsewhere.md'), deck.cards[3]);
  assert.deepEqual(projected.files, deck.files);
  assert.equal(projected.revisions['deck.md'], 'saved');
  assert.equal(deck.cards.length, 4);
});

test('add appends exactly one matching card and retains existing snapshot occurrences', () => {
  const deck = snapshot();
  const operation = captureOperation(deck, { action: 'add', source: 'deck.md', revision: 'old', question: 'Same', answer: 'Answer' });
  const planned = planContent(entry('Same'), operation);
  assert.equal(planned.text, entry('Same') + entry('Same'));
  assert.equal(planned.matched, 0);
  assert.equal(planned.removed, '');
  const projected = projectOperation(deck, operation, 'saved', parse);
  assert.equal(projected.cards.length, 5);
  const source = projected.cards.filter(card => card.source === 'deck.md');
  assert.deepEqual(source.slice(0, 3), deck.cards.slice(0, 3));
  assert.equal(source[3].question, 'Same');
  assert.ok(!deck.cards.some(card => card.id === source[3].id));
  const empty: DeckState = { cards: [], files: [], errors: [], revisions: {} };
  const created = projectOperation(empty, operation, 'new', parse);
  assert.deepEqual(created.files, ['deck.md']);
  assert.equal(created.cards.length, 1);
});

test('saved source positions update without importing external additions into the practice snapshot', () => {
  const cards = parseBrowserCards(entry('One') + entry('Two'), 'deck.md', text => text);
  const deck: DeckState = { cards, files: ['deck.md'], errors: [], revisions: { 'deck.md': 'old' } };
  const operation: CardOperation = { source: 'deck.md', action: 'edit', original: cards[0], replacement: { question: 'Changed\n\nparagraph', answer: 'Answer' } };
  const saved = entry('External') + entry('Changed\n\nparagraph') + entry('Two');
  const result = projectOperation(deck, operation, 'new', (text, source) => parseBrowserCards(text, source, text => text), saved);
  assert.deepEqual(result.cards.map(card => card.question), ['Changed\n\nparagraph', 'Two']);
  assert.deepEqual(result.cards.map(card => card.id), cards.map(card => card.id));
  assert.deepEqual(result.cards.map(card => card.line), parseCardRanges(saved, 'deck.md').slice(1).map(range => range.content.line));
});
