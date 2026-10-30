import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewArchive, reviewSource } from '../src/lib/mutation-review.ts';
import type { CardOperation } from '../src/lib/onedrive/operations.ts';

const pair = (question: string) => ({ question, answer: 'Answer' });
const entry = (question: string) => `# question\n${question}\n\n# answer\nAnswer\n\n`;

test('add review never claims authorship of an identical addition', () => {
  const operation: CardOperation = { action: 'add', source: 'cards.md', replacement: pair('New') };
  assert.equal(reviewSource(operation, entry('Old'), entry('Old')), 'safe-to-retry');
  assert.equal(reviewSource(operation, entry('Old'), entry('Old') + entry('New')), 'needs-review');
});

test('edit review accounts for replacements already present and all original duplicates', () => {
  const operation: CardOperation = { action: 'edit', source: 'cards.md', original: pair('Old'), replacement: pair('New') };
  const before = entry('Old') + entry('New') + entry('Old');
  assert.equal(reviewSource(operation, before, entry('New') + entry('New')), 'needs-review');
  assert.equal(reviewSource(operation, before, entry('New') + entry('New') + entry('New')), 'satisfied');
  assert.equal(reviewSource(operation, before, before), 'safe-to-retry');
});

test('edit review compares the normalized replacement that is actually stored', () => {
  const operation: CardOperation = { action: 'edit', source: 'cards.md', original: pair('Old'), replacement: { question: '  New  ', answer: '\r\nAnswer\r\n' } };
  assert.equal(reviewSource(operation, entry('Old'), entry('New')), 'satisfied');
});

test('remove requires the source to be absent and at least one archive match', () => {
  const operation: CardOperation = { action: 'remove', source: 'cards.md', original: pair('Old') };
  const before = entry('Old') + entry('Old');
  assert.equal(reviewSource(operation, before, '', entry('Old')), 'satisfied');
  assert.equal(reviewSource(operation, before, '', ''), 'needs-review');
  assert.equal(reviewSource(operation, before, before, entry('Old')), 'safe-to-retry');
  assert.equal(reviewSource(operation, before, before, ''), 'needs-review');
});

test('archive review accepts any matching archived entry, including an older one', () => {
  const operation: CardOperation = { action: 'remove', source: 'cards.md', original: pair('Old') };
  const before = entry('Old');
  const after = before + entry('Old');
  assert.equal(reviewArchive(operation, before, after, before), 'satisfied');
  assert.equal(reviewArchive(operation, before, after, after), 'satisfied');
  assert.equal(reviewArchive(operation, '', after, ''), 'safe-to-retry');
  assert.equal(reviewArchive(operation, before, after, before + entry('Other')), 'satisfied');
  assert.equal(reviewArchive(operation, before, after, entry('Other')), 'needs-review');
});
