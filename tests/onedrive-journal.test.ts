import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeckRequestError } from '../src/lib/deck-client.ts';
import { GraphError } from '../src/lib/onedrive/graph.ts';
import type { GraphClient } from '../src/lib/onedrive/graph.ts';
import { createOperationJournal } from '../src/lib/onedrive/journal.ts';
import type { PendingOperation } from '../src/lib/onedrive/journal.ts';

function operation(id = 'op1'): PendingOperation {
  return { id, source: 'cards.md', action: 'add', stage: 'source-ready', sourceWrite: { id: 'source', name: 'cards.md', before: 'old', revision: 's1', after: 'new' } };
}
function fixture(initial?: unknown) {
  let text: string | null = initial === undefined ? null : typeof initial === 'string' ? initial : JSON.stringify(initial);
  let revision = 1;
  let nextWriteError: Error | undefined;
  let commitOnError = false;
  let replaceBeforeWrite: unknown;
  const writes: Array<{ id: string; revision: string | null; text: string }> = [];
  const graph = {
    async findChild(folderId: string, name: string) {
      assert.equal(folderId, 'root');
      assert.equal(name, '.flashcards-operation.json');
      return text === null ? null : { id: 'journal', name, file: {}, eTag: `j${revision}` };
    },
    async readText(id: string) {
      assert.equal(id, 'journal');
      if (text === null) throw new GraphError('missing', { status: 404, code: 'itemNotFound' });
      return { id, revision: `j${revision}`, text };
    },
    async createFile(folderId: string, name: string, value: string) {
      assert.equal(folderId, 'root');
      assert.equal(name, '.flashcards-operation.json');
      if (text !== null) throw new GraphError('exists', { status: 409, code: 'nameAlreadyExists' });
      writes.push({ id: name, revision: null, text: value });
      if (!nextWriteError || commitOnError) { text = value; revision++; }
      if (nextWriteError) { const error = nextWriteError; nextWriteError = undefined; throw error; }
      return { id: 'journal', name, eTag: `j${revision}`, file: {} };
    },
    async replaceText(id: string, expected: string, value: string) {
      assert.equal(id, 'journal');
      writes.push({ id, revision: expected, text: value });
      if (replaceBeforeWrite !== undefined) { text = JSON.stringify(replaceBeforeWrite); revision++; replaceBeforeWrite = undefined; }
      if (expected !== `j${revision}`) throw new GraphError('stale', { status: 412, code: 'preconditionFailed' });
      if (!nextWriteError || commitOnError) { text = value; revision++; }
      if (nextWriteError) { const error = nextWriteError; nextWriteError = undefined; throw error; }
      return { id, name: '.flashcards-operation.json', eTag: `j${revision}`, file: {} };
    },
  } as GraphClient;
  return {
    journal: createOperationJournal(graph, 'root'), writes,
    set(value: unknown) { text = JSON.stringify(value); revision++; },
    race(value: unknown) { replaceBeforeWrite = value; },
    fail(error: Error, committed = false) { nextWriteError = error; commitOnError = committed; },
    document() { return text === null ? null : JSON.parse(text); },
  };
}

test('claim creates only the journal, updates use current eTag, release leaves an idle document', async () => {
  const f = fixture();
  const op = operation();
  assert.equal(await f.journal.inspect(), null);
  await f.journal.claim(op);
  assert.equal(f.writes[0].id, '.flashcards-operation.json');
  assert.equal(f.writes[0].revision, null);
  op.stage = 'source-writing';
  await f.journal.update(op);
  assert.equal(f.writes[1].revision, 'j2');
  await f.journal.release(op.id);
  assert.equal(f.writes[2].revision, 'j3');
  assert.deepEqual(f.document(), { version: 1, operation: null });
});

test('claim uses CAS on an idle journal and rejects all active operations', async () => {
  const idle = fixture({ version: 1, operation: null });
  await idle.journal.claim(operation());
  assert.equal(idle.writes[0].revision, 'j1');
  for (const id of ['op1', 'other']) {
    const active = fixture({ version: 1, operation: operation(id) });
    await assert.rejects(active.journal.claim(operation()), error => error instanceof DeckRequestError && /pending/i.test(error.message));
    assert.equal(active.writes.length, 0);
  }
});

test('inspect authorizes explicit reviewed release but mismatched local owner calls are internal errors', async () => {
  const f = fixture({ version: 1, operation: operation() });
  await assert.rejects(f.journal.release('op1'), error => error instanceof Error && !(error instanceof DeckRequestError));
  assert.equal((await f.journal.inspect())?.id, 'op1');
  await assert.rejects(f.journal.update(operation('other')), error => error instanceof Error && !(error instanceof DeckRequestError));
  await f.journal.release('op1');
  assert.deepEqual(f.document(), { version: 1, operation: null });
});

test('remote ownership changes block update and release without overwriting the competing operation', async () => {
  for (const method of ['update', 'release'] as const) {
    const f = fixture({ version: 1, operation: operation() });
    await f.journal.inspect();
    f.set({ version: 1, operation: operation('other') });
    await assert.rejects(method === 'update' ? f.journal.update(operation()) : f.journal.release('op1'), DeckRequestError);
    assert.equal(f.writes.length, 0);
    assert.equal(f.document().operation.id, 'other');
  }
});

test('CAS race never overwrites the winning journal operation', async () => {
  const f = fixture({ version: 1, operation: null });
  f.race({ version: 1, operation: operation('winner') });
  await assert.rejects(f.journal.claim(operation()), DeckRequestError);
  assert.equal(f.document().operation.id, 'winner');
  assert.equal(f.writes.length, 1);
});

test('unknown journal writes are confirmed only by exact journal content without repeating writes', async () => {
  const f = fixture();
  f.fail(new GraphError('unknown', { status: 503, code: 'server' }, true), true);
  await f.journal.claim(operation());
  assert.equal(f.writes.length, 1);
  f.fail(new GraphError('unknown', { status: 0, code: 'network' }, true), true);
  await f.journal.update({ ...operation(), stage: 'source-writing' });
  assert.equal(f.writes.length, 2);
  f.fail(new GraphError('unknown', { status: 0, code: 'network' }, true), true);
  await f.journal.release('op1');
  assert.equal(f.writes.length, 3);
  assert.deepEqual(f.document(), { version: 1, operation: null });
});

test('unconfirmed journal writes fail explicitly even when operation id is the same', async () => {
  const absent = fixture();
  absent.fail(new GraphError('unknown', { status: 0, code: 'network' }, true));
  await assert.rejects(absent.journal.claim(operation()), error => error instanceof DeckRequestError && /unknown/.test(error.message));
  assert.equal(absent.writes.length, 1);
  const active = fixture({ version: 1, operation: operation() });
  await active.journal.inspect();
  active.fail(new GraphError('unknown', { status: 0, code: 'network' }, true));
  await assert.rejects(active.journal.update({ ...operation(), stage: 'source-writing' }), DeckRequestError);
  assert.equal(active.document().operation.stage, 'source-ready');
});

test('external malformed journals retain causes and invalid local plans fail internally', async () => {
  const op = operation();
  const invalid = ['{', null, {}, { version: 2, operation: null },
    { version: 1, operation: { ...op, sourceWrite: { ...op.sourceWrite, revision: null } } },
    { version: 1, operation: { ...op, action: 'remove' } },
    { version: 1, operation: { ...op, stage: 'archive-ready' } },
    { version: 1, operation: { ...op, archiveWrite: op.sourceWrite } }];
  for (const value of invalid) {
    await assert.rejects(fixture(value).journal.inspect(), error => error instanceof DeckRequestError && error.cause instanceof Error);
  }
  const f = fixture();
  await assert.rejects(f.journal.claim({ ...op, action: 'remove' }), error => error instanceof Error && !(error instanceof DeckRequestError));
  const bug = new Error('Internal Graph defect');
  f.fail(bug);
  await assert.rejects(f.journal.claim(op), error => error === bug);
});

test('remove journals require an archive plan and retain full source/archive content', async () => {
  const op: PendingOperation = { ...operation(), action: 'remove', stage: 'archive-ready', archiveWrite: { id: null, name: 'removed.md', before: null, revision: null, after: 'archived card' } };
  const f = fixture();
  await f.journal.claim(op);
  assert.deepEqual(await f.journal.inspect(), op);
  assert.equal(f.writes.length, 1);
});


test('nested existing sources can be edited and removed; new files and archive names remain constrained', async () => {
  const nested: PendingOperation = { ...operation(), source: 'nested/deck.md', action: 'edit', sourceWrite: { ...operation().sourceWrite, name: 'nested/deck.md' } };
  const f = fixture();
  await f.journal.claim(nested);
  assert.deepEqual(await f.journal.inspect(), nested);
  await f.journal.update({ ...nested, stage: 'source-writing' });
  await f.journal.release(nested.id);
  const removal: PendingOperation = { ...nested, action: 'remove', stage: 'archive-ready', archiveWrite: { id: null, name: 'removed.md', before: null, revision: null, after: 'archived' } };
  await f.journal.claim(removal);
  assert.deepEqual(await f.journal.inspect(), removal);
  for (const name of ['/deck.md', '../deck.md', 'nested/../deck.md', 'nested//deck.md', 'nested/./deck.md', 'nested\\deck.md']) {
    const bad = { ...nested, source: name, sourceWrite: { ...nested.sourceWrite, name } };
    await assert.rejects(fixture({ version: 1, operation: bad }).journal.inspect(), DeckRequestError);
  }
  const newNested = { ...nested, action: 'add', sourceWrite: { ...nested.sourceWrite, id: null, before: null, revision: null } };
  await assert.rejects(fixture({ version: 1, operation: newNested }).journal.inspect(), DeckRequestError);
  const wrongArchive = { ...removal, archiveWrite: { ...removal.archiveWrite, name: 'other.md' } };
  await assert.rejects(fixture({ version: 1, operation: wrongArchive }).journal.inspect(), DeckRequestError);
});
