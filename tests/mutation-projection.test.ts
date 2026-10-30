import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecoveredProjector } from '../src/lib/mutation-projection.ts';
import { parseBrowserCards } from '../src/lib/browser-cards.ts';
import { captureOperation } from '../src/lib/onedrive/operations.ts';
import type { StoredMutation } from '../src/lib/mutation-storage.ts';
const entry = (q: string) => `# question\n${q}\n\n# answer\nA\n\n`;
const parse: typeof parseBrowserCards = (text, source) => parseBrowserCards(text, source, value => value);
const project = createRecoveredProjector(parse);

test('recovered changes project onto the current practice snapshot without importing unrelated changes', () => {
  const cards = parse(entry('Old'), 'cards.md');
  const snapshot = { cards, files: ['cards.md'], errors: [], revisions: { 'cards.md': 'before' } };
  const request = { action: 'add' as const, source: 'cards.md', revision: 'before', question: 'Added', answer: 'A' };
  const item: StoredMutation = { id: 'id', createdAt: 1, destination: { provider: 'onedrive', driveId: 'd', folderId: 'f' }, request, operation: captureOperation(snapshot, request), snapshot, stage: 'source-writing', attempts: 1 };
  const saved = { ...snapshot, cards: parse(entry('Old') + entry('Added') + entry('External'), 'cards.md'), revisions: { 'cards.md': 'after' } };
  const result = project(snapshot, item, saved, 'source-writing');
  assert.deepEqual(result.cards.map(card => card.question), ['Old', 'Added']);
  assert.equal(result.cards[0].id, cards[0].id);
  assert.equal(result.revisions['cards.md'], 'after');
  const alreadyLoaded = { ...snapshot, cards: parse(entry('Old') + entry('Added'), 'cards.md') };
  assert.equal(project(alreadyLoaded, item, saved, 'releasing').cards.length, 2);
});

test('recovered edit already visible in the loaded deck is not applied twice', () => {
  const cards = parse(entry('Old'), 'cards.md');
  const snapshot = { cards, files: ['cards.md'], errors: [], revisions: { 'cards.md': 'before' } };
  const request = { action: 'edit' as const, source: 'cards.md', revision: 'before', index: 0, question: 'New', answer: 'A' };
  const item: StoredMutation = { id: 'id', createdAt: 1, destination: { provider: 'onedrive', driveId: 'd', folderId: 'f' }, request, operation: captureOperation(snapshot, request), snapshot, stage: 'source-writing', attempts: 1 };
  const loaded = { ...snapshot, cards: parse(entry('New'), 'cards.md') };
  const result = project(loaded, item, { ...loaded, revisions: { 'cards.md': 'after' } }, 'source-writing');
  assert.deepEqual(result.cards.map(card => card.question), ['New']);
  assert.equal(result.cards[0].id, loaded.cards[0].id);
});
