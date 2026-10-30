import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeckRequestError } from '../src/lib/deck-client.ts';
import { createFolderConnection, type ConnectedFolder } from '../src/lib/onedrive/connection.ts';
import { createFolderMemory } from '../src/lib/onedrive/folder-memory.ts';
import type { GraphClient, GraphItem } from '../src/lib/onedrive/graph.ts';
import type { PendingOperation } from '../src/lib/onedrive/journal.ts';

const root: GraphItem = { id: 'root', name: 'OneDrive', folder: {} };
const folder = (id: string): GraphItem => ({ id, name: id, folder: {} });
const operation = (id: string): PendingOperation => ({
  id, source: 'deck.md', action: 'add', stage: 'source-ready',
  sourceWrite: { id: null, name: 'deck.md', before: null, revision: null, after: '# question\nQ\n\n# answer\nA\n' },
});

function fixture() {
  const journals = new Map<string, PendingOperation | null>([['A', operation('save-A')], ['B', operation('save-B')]]);
  const hooks: { root?: () => void; remember?: () => void; find?: (name: string) => void } = {};
  const written: string[] = [];
  const graph = {
    async driveId() { return 'drive'; },
    async root() { hooks.root?.(); return root; },
    async findChild(parent: string, name: string) {
      hooks.find?.(name);
      return name === '.flashcards-operation.json' ? { id: parent, name, file: {} } : null;
    },
    async readText(id: string) {
      return { id, revision: 'etag', text: JSON.stringify({ version: 1, operation: journals.get(id) ?? null }) };
    },
    async replaceText(id: string, _revision: string, text: string) {
      journals.set(id, JSON.parse(text).operation);
      written.push(id);
      return { id, name: '.flashcards-operation.json', file: {}, eTag: 'next' };
    },
    async createFile(parent: string, name: string, _text: string) {
      written.push(`${parent}/${name}`);
      return { id: 'source', name, file: {}, eTag: 'saved' };
    },
  } as unknown as GraphClient;
  const memory = { remember() { hooks.remember?.(); }, recall() { return null; } };
  const states: ConnectedFolder[] = [];
  const connection = createFolderConnection(graph, memory, state => states.push(state));
  return { connection, hooks, states, written, journals };
}

for (const boundary of ['root', 'remember'] as const) {
  test(`failed folder selection at ${boundary} preserves active backend and recovery ownership`, async () => {
    const f = fixture();
    await f.connection.select(folder('A'));
    const selected = f.states.at(-1)!;
    const failure = new Error(`${boundary} failed`);
    f.hooks[boundary] = () => { throw failure; };
    await assert.rejects(f.connection.select(folder('B')), error => error === failure);
    assert.equal(f.states.length, 1);
    assert.equal(f.states.at(-1), selected);
    await f.connection.clearReviewed();
    assert.deepEqual(f.written, ['A']);
    assert.equal(f.journals.get('B')?.id, 'save-B');
    assert.equal(f.states.at(-1)!.folder.id, 'A');
  });
}

test('successful selection publishes folder, backend and pending operation together', async () => {
  const f = fixture();
  await f.connection.select(folder('A'));
  const previous = f.states.at(-1)!;
  await f.connection.select(folder('B'));
  const next = f.states.at(-1)!;
  assert.equal(next.folder.id, 'B');
  assert.equal(next.recovery?.id, 'save-B');
  assert.notEqual(next.backend, previous.backend);
  await f.connection.clearReviewed();
  assert.deepEqual(f.written, ['B']);
  assert.equal(f.states.at(-1)!.backend, next.backend, 'recovery updates must not reload the practice backend');
});

test('mutation and unexpected recovery inspection failures both retain their identity', async () => {
  const f = fixture();
  await f.connection.select(folder('A'));
  const primary = new Error('source planning bug');
  const secondary = new TypeError('recovery inspection bug');
  f.hooks.find = name => { throw name === '.flashcards-operation.json' ? secondary : primary; };
  await assert.rejects(f.states.at(-1)!.backend.mutate({
    action: 'add', source: 'deck.md', revision: null, question: 'Q', answer: 'A',
  }, { cards: [], files: [], revisions: {}, errors: [] }), error =>
    error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === secondary);
});

test('expected recovery inspection failure preserves the mutation failure and reports the diagnostic', async () => {
  const f = fixture();
  await f.connection.select(folder('A'));
  const selected = f.states.at(-1)!;
  const primary = new Error('source planning bug');
  f.hooks.find = name => { throw name === '.flashcards-operation.json' ? new DeckRequestError('recovery unavailable') : primary; };
  await assert.rejects(selected.backend.mutate({
    action: 'add', source: 'deck.md', revision: null, question: 'Q', answer: 'A',
  }, { cards: [], files: [], revisions: {}, errors: [] }), error => error === primary);
  assert.equal(f.states.at(-1)!.recoveryError, 'recovery unavailable');
  assert.equal(f.states.at(-1)!.backend, selected.backend);
});

test('retry failures preserve both the original operation and inspection exceptions', async () => {
  const f = fixture();
  await f.connection.select(folder('A'));
  const primary = new Error('recovery execution bug');
  const secondary = new TypeError('subsequent inspection bug');
  let calls = 0;
  f.hooks.find = () => { throw ++calls === 1 ? primary : secondary; };
  await assert.rejects(f.connection.retryPending(), error =>
    error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === secondary);
});

test('successful recovery clears the journal and publishes a fresh backend for explicit reload', async () => {
  const f = fixture();
  await f.connection.select(folder('A'));
  const previous = f.states.at(-1)!;
  await f.connection.retryPending();
  const recovered = f.states.at(-1)!;
  assert.equal(recovered.folder.id, 'A');
  assert.equal(recovered.recovery, null);
  assert.notEqual(recovered.backend, previous.backend);
  assert.deepEqual(f.written, ['A', 'A/deck.md', 'A']);
});

test('folder memory handles unavailable storage access and preserves unexpected defects', () => {
  const unavailable = new DOMException('blocked', 'SecurityError');
  const memory = createFolderMemory('client', () => { throw unavailable; });
  assert.throws(() => memory.recall('root'), error => error instanceof Error && error.cause === unavailable);
  assert.throws(() => memory.remember('A', 'root'), error => error instanceof Error && error.cause === unavailable);
  const bug = new Error('storage adapter bug');
  const broken = createFolderMemory('client', () => { throw bug; });
  assert.throws(() => broken.recall('root'), error => error === bug);
});
