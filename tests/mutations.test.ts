import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, rm, symlink, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './support/temporary-directory.ts';
import { createDeckStore } from '../server/deck.js';
import { MutationError } from '../server/mutations.js';
import { materialRevision } from '../server/revision.js';
import { createWriteTransaction } from '../server/write-transaction.js';
import { parseCardRanges, parseCards } from '../server/parser.js';
import { applyMutation } from '../src/lib/card-mutations.js';
import { updateSession } from '../src/lib/session.js';
import type { MutationRequest } from '../src/lib/types.js';

const entry = (q: string, a = 'Answer') => `# question\n${q}\n\n# answer\n${a}\n\n`;

test('raw spans edit the correct duplicate and retain CRLF, multiline positions and round identity', async t => {
  const directory = await temporaryDirectory(t);
  const original = (entry('Same') + entry('Same') + entry('Last')).replaceAll('\n', '\r\n');
  const file = path.join(directory, 'deck.md');
  await writeFile(file, original);
  const store = await createDeckStore(directory);
  const deck = await store.getState();
  const request: MutationRequest = { action: 'edit', source: 'deck.md', revision: deck.revisions['deck.md'], index: 1, question: 'Changed\n\nparagraph', answer: 'New\nanswer' };
  const result = await store.mutate(request);
  assert.deepEqual(result.cards.map(card => card.question), ['Same', 'Changed\n\nparagraph', 'Last']);
  const written = await readFile(file, 'utf8');
  const ranges = parseCardRanges(original, 'deck.md');
  assert.equal(written.slice(0, ranges[1].start), original.slice(0, ranges[1].start));
  assert.ok(written.endsWith(original.slice(ranges[2].start)));
  assert.equal(written.replaceAll('\r\n', '').includes('\n'), false);
  const updated = applyMutation(deck, request, result);
  assert.deepEqual(updated.cards.map(card => card.id), deck.cards.map(card => card.id));
  assert.ok(updated.cards[2].line > deck.cards[2].line);
  const previous = { order: [deck.cards[2], deck.cards[1], deck.cards[0]], index: 1, revealed: true };
  const session = updateSession(previous, updated.cards);
  assert.deepEqual(session.order.map(card => card.id), previous.order.map(card => card.id));
  assert.equal(session.revealed, true);
  assert.equal(session.index, 1);
});

test('mutations only update the page snapshot; stale tabs and external target edits reject writes', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, 'a.md'), entry('A'));
  await writeFile(path.join(directory, 'b.md'), entry('B'));
  const store = await createDeckStore(directory);
  const tabA = await store.getState();
  const tabB = await store.getState();
  await writeFile(path.join(directory, 'b.md'), entry('External'));
  await writeFile(path.join(directory, 'external.md'), entry('New external file'));
  const request: MutationRequest = { action: 'edit', source: 'a.md', revision: tabA.revisions['a.md'], index: 0, question: 'Updated', answer: 'Answer' };
  const updated = applyMutation(tabA, request, await store.mutate(request));
  assert.deepEqual(updated.files, ['a.md', 'b.md']);
  assert.equal(updated.cards.find(card => card.source === 'b.md')!.question, 'B');
  assert.equal(tabB.cards[0].question, 'A');
  await assert.rejects(store.mutate(request), error => error instanceof MutationError && error.status === 409);
  await assert.rejects(store.mutate({ ...request, source: 'b.md', revision: tabA.revisions['b.md'] }), /changed since/);
  assert.equal((await store.getState()).cards.find(card => card.source === 'b.md')!.question, 'External');
});

test('remove first/middle/last archives exact entries and excludes archive from practice', async t => {
  for (const index of [0, 1, 2]) {
    const directory = await temporaryDirectory(t);
    const text = entry('One') + entry('Two') + entry('Three');
    await writeFile(path.join(directory, 'deck.md'), text);
    const store = await createDeckStore(directory);
    const deck = await store.getState();
    const request: MutationRequest = { action: 'remove', source: 'deck.md', revision: deck.revisions['deck.md'], index };
    const result = await store.mutate(request);
    const updated = applyMutation(deck, request, result);
    const previous = { order: deck.cards, index, revealed: true };
    const session = updateSession(previous, updated.cards);
    assert.equal(session.index, index === 2 ? 1 : index);
    assert.equal(session.revealed, false);
    assert.deepEqual(session.order.map(card => card.id), deck.cards.filter((_, i) => i !== index).map(card => card.id));
    const ranges = parseCardRanges(text, 'deck.md');
    assert.equal(await readFile(path.join(directory, 'removed.md'), 'utf8'), text.slice(ranges[index].start, ranges[index].end));
    assert.deepEqual((await store.getState()).files, ['deck.md']);
    assert.equal((await store.getState()).cards.length, 2);
  }
});

test('removing the only card leaves an empty round', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, 'deck.md'), entry('Only'));
  const store = await createDeckStore(directory);
  const deck = await store.getState();
  const result = await store.mutate({ action: 'remove', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 });
  assert.deepEqual(result.cards, []);
  assert.deepEqual(updateSession({ order: deck.cards, index: 0, revealed: true }, []), { order: [], index: 0, revealed: false });
});

test('adds create files, append to matching rounds, and reject invalid input without disk changes', async t => {
  const directory = await temporaryDirectory(t);
  const store = await createDeckStore(directory);
  const deck = await store.getState();
  const request: MutationRequest = { action: 'add', source: 'default.md', revision: null, question: 'New', answer: 'Answer' };
  const updated = applyMutation(deck, request, await store.mutate(request));
  assert.equal(updated.cards.length, 1);
  assert.equal(updateSession({ order: [], index: 0, revealed: false }, updated.cards).order.length, 1);
  const before = await readFile(path.join(directory, 'default.md'), 'utf8');
  for (const bad of [
    { ...request, source: '../escape.md' }, { ...request, source: 'removed.md' },
    { ...request, source: 'a/b.md' }, { ...request, source: 'foo.md', question: ' ' },
    { ...request, source: 'foo.md', question: 'x\n# answer\nOops' },
    { ...request, source: 'foo.md', answer: 'A\n---' },
    { ...request, action: 'bogus' },
  ]) await assert.rejects(store.mutate(bad), MutationError);
  assert.equal(await readFile(path.join(directory, 'default.md'), 'utf8'), before);
  await assert.rejects(store.mutate(request), /changed since/);
});

test('root/file/folder symlinks survive writes and removals', async t => {
  const directory = await temporaryDirectory(t);
  await mkdir(path.join(directory, 'target'));
  await mkdir(path.join(directory, 'external'));
  await writeFile(path.join(directory, 'card.md'), entry('Linked'));
  await writeFile(path.join(directory, 'external', 'nested.md'), entry('Nested'));
  await symlink(path.join(directory, 'target'), path.join(directory, 'root'));
  await symlink(path.join(directory, 'card.md'), path.join(directory, 'target', 'linked.md'));
  await symlink(path.join(directory, 'external'), path.join(directory, 'target', 'folder'));
  const store = await createDeckStore(path.join(directory, 'root'));
  for (const source of ['linked.md', 'folder/nested.md']) {
    let deck = await store.getState();
    await store.mutate({ action: 'edit', source, revision: deck.revisions[source], index: 0, question: 'Edited', answer: 'Answer' });
    deck = await store.getState();
    await store.mutate({ action: 'remove', source, revision: deck.revisions[source], index: 0 });
  }
  assert.ok((await lstat(path.join(directory, 'target', 'linked.md'))).isSymbolicLink());
  assert.ok((await lstat(path.join(directory, 'target', 'folder'))).isSymbolicLink());
  assert.equal(await readFile(path.join(directory, 'card.md'), 'utf8'), '');
});

test('interrupted removal replays once, refuses conflicting recovery, and preserves both originals before archive failure', async t => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, 'deck.md');
  const archive = path.join(directory, 'removed.md');
  const before = entry('One') + entry('Two');
  const removed = entry('One');
  const changes = [{ filename: archive, before: null, after: removed }, { filename: source, before, after: entry('Two') }];
  await writeFile(source, before);
  await writeFile(archive, removed); // Simulate interruption after archive replacement.
  const journal = path.join(directory, '.flashcards-removal.json');
  await writeFile(journal, JSON.stringify(changes));
  const transaction = createWriteTransaction(directory);
  await transaction.recover();
  await transaction.recover();
  assert.equal(await readFile(archive, 'utf8'), removed);
  assert.equal(await readFile(source, 'utf8'), entry('Two'));
  await writeFile(journal, JSON.stringify(changes));
  await writeFile(source, entry('External'));
  await assert.rejects(transaction.recover(), /recovery conflict/);
  assert.equal(await readFile(source, 'utf8'), entry('External'));
  await rm(journal);
  await rm(archive);
  await mkdir(archive);
  const store = await createDeckStore(directory);
  await assert.rejects(store.mutate({ action: 'remove', source: 'deck.md', revision: materialRevision(entry('External')), index: 0 }), /EISDIR/);
  assert.equal(await readFile(source, 'utf8'), entry('External'));
});

test('archive aliasing the source rejects removal without changing either file', async t => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, 'deck.md');
  await writeFile(file, entry('Keep'));
  await symlink(file, path.join(directory, 'removed.md'));
  const store = await createDeckStore(directory);
  const deck = await store.getState();
  await assert.rejects(store.mutate({ action: 'remove', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 }), /same file/);
  assert.equal(await readFile(file, 'utf8'), entry('Keep'));
});

test('concurrent writes from the same revision serialize and only one succeeds', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, 'deck.md'), entry('Original'));
  const store = await createDeckStore(directory);
  const deck = await store.getState();
  const request = { action: 'edit', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0, question: 'Changed', answer: 'Answer' };
  const outcomes = await Promise.allSettled([store.mutate(request), store.mutate(request)]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof MutationError);
  assert.equal(rejected.reason.status, 409);
});

test('CR-only and fenced markers preserve raw positions and ignore nested headings', async t => {
  const directory = await temporaryDirectory(t);
  const text = entry('First', '```md\n# question\n# answer\n```') + entry('Second');
  const raw = text.replaceAll('\n', '\r');
  await writeFile(path.join(directory, 'deck.md'), raw);
  const store = await createDeckStore(directory);
  const deck = await store.getState();
  assert.equal(deck.cards.length, 2);
  const result = await store.mutate({ action: 'edit', source: 'deck.md', revision: deck.revisions['deck.md'], index: 1, question: 'Updated', answer: 'Answer' });
  assert.equal(result.cards[0].answer, '```md\n# question\n# answer\n```');
  assert.ok((await readFile(path.join(directory, 'deck.md'), 'utf8')).startsWith(entry('First', '```md\n# question\n# answer\n```').replaceAll('\n', '\r')));
});

test('removing a preceding card retains current ID, reveal and order while progress moves with it', () => {
  const cards = parseCards(entry('One') + entry('Two') + entry('Three'), 'deck.md');
  const previous = { order: cards, index: 2, revealed: true };
  const session = updateSession(previous, cards.slice(1));
  assert.equal(session.order[session.index].id, cards[2].id);
  assert.equal(session.index, 1);
  assert.equal(session.revealed, true);
  assert.equal(session.order.length - session.index - 1, 0);
});

test('dangling destination links fail without replacing the symbolic link', async t => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, 'default.md');
  await symlink('missing.md', file);
  const store = await createDeckStore(directory);
  await assert.rejects(store.mutate({ action: 'add', source: 'default.md', revision: null, question: 'Q', answer: 'A' }), /ENOENT/);
  assert.ok((await lstat(file)).isSymbolicLink());
});
