import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecoveredProjector } from '../src/lib/mutation-projection.ts';
import { parseBrowserCards } from '../src/lib/browser-cards.ts';
import { captureOperation } from '../src/lib/onedrive/operations.ts';
import type { StoredMutation } from '../src/lib/mutation-storage.ts';
import { startSession, advancePractice, updateSession } from '../src/lib/session.ts';
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

test('an in-place cross-tab addition preserves the current practice position', () => {
  const cards = parse(entry('One') + entry('Two') + entry('Three'), 'cards.md');
  const snapshot = { cards, files: ['cards.md'], errors: [], revisions: { 'cards.md': 'before' } };
  const request = { action: 'add' as const, source: 'cards.md', revision: 'before', question: 'Added', answer: 'A' };
  const item: StoredMutation = { id: 'id', createdAt: 1, destination: { provider: 'onedrive', driveId: 'd', folderId: 'f' }, request, operation: captureOperation(snapshot, request), snapshot, stage: 'releasing', attempts: 0 };
  const session = advancePractice(advancePractice(startSession(cards)));
  const current = session.order[session.index].id;
  const updated = project(snapshot, item, { ...snapshot, revisions: { 'cards.md': 'after' } }, 'source-writing');
  const next = updateSession(session, updated.cards);
  assert.equal(next.index, session.index);
  assert.equal(next.order[next.index].id, current);
  assert.equal(next.order.length, 4);
});

test('pending removals advance the session and restore cards if dismissed', async () => {
  const { createPendingProjector } = await import('../src/lib/pending-projection.ts');
  const pending = createPendingProjector(parse);
  const cards = parse(entry('One') + entry('Two') + entry('One') + entry('Three'), 'cards.md');
  const deck = { cards, files: ['cards.md'], errors: [], revisions: { 'cards.md': 'before' } };
  const request = { action: 'remove' as const, source: 'cards.md', revision: 'before', index: 0 };
  const item: StoredMutation = { id: 'remove', createdAt: 1, destination: { provider: 'onedrive', driveId: 'd', folderId: 'f' }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  const session = { order: cards, index: 0, revealed: true };
  const visible = pending(deck, [item], [item.id]);
  const next = updateSession(session, visible.cards);
  assert.deepEqual(visible.cards.map(card => card.question), ['Two', 'Three']);
  assert.equal(next.order[next.index].question, 'Two');
  assert.equal(next.revealed, false);
  assert.equal(pending(deck, [item], []).cards.length, 4);
  assert.equal(pending(deck, [], []).cards.length, 4);
});

test('pending edits are visible and subsequent changes target the edited pair', async () => {
  const { createPendingProjector } = await import('../src/lib/pending-projection.ts');
  const pending = createPendingProjector(parse);
  const cards = parse(entry('Old') + entry('Old'), 'cards.md');
  const deck = { cards, files: ['cards.md'], errors: [], revisions: { 'cards.md': 'before' } };
  const request = { action: 'edit' as const, source: 'cards.md', revision: 'before', index: 0, question: 'New', answer: 'A' };
  const item: StoredMutation = { id: 'edit', createdAt: 1, destination: { provider: 'onedrive', driveId: 'd', folderId: 'f' }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  const visible = pending(deck, [item], [item.id]);
  assert.deepEqual(visible.cards.map(card => card.question), ['New', 'New']);
  assert.deepEqual(visible.cards.map(card => card.id), cards.map(card => card.id));
  const remove = { action: 'remove' as const, source: 'cards.md', revision: 'before', index: 0 };
  assert.equal(captureOperation(visible, remove).original?.question, 'New');
  assert.deepEqual(pending(visible, [item], [item.id]).cards.map(card => card.question), ['New', 'New']);
});
