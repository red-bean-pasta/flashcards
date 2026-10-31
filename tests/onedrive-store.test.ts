import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBrowserCards } from '../src/lib/browser-cards.ts';
import { DeckRequestError } from '../src/lib/deck-client.ts';
import { GraphError } from '../src/lib/onedrive/graph.ts';
import type { GraphClient, GraphItem } from '../src/lib/onedrive/graph.ts';
import { createOneDriveStore } from '../src/lib/onedrive/store.ts';
import { captureOperation } from '../src/lib/onedrive/operations.ts';
import type { StoredMutation } from '../src/lib/mutation-storage.ts';

const entry = (q: string, a = 'Answer') => `# question\n${q}\n\n# answer\n${a}\n\n`;
const parse: typeof parseBrowserCards = (text, source) => parseBrowserCards(text, source, text => text);
const JOURNAL = '.flashcards-operation.json';
type Node = { item: GraphItem; parent: string; text: string };
type Write = { kind: 'create' | 'replace'; id: string; parent: string; name: string; text: string; revision?: string };

function fixture() {
  let sequence = 0;
  const nodes = new Map<string, Node>();
  const folder: GraphItem = { id: 'root', name: 'Cards', folder: {} };
  const committed: Write[] = [];
  const reads: string[] = [];
  const hooks: { before?: (write: Write) => Promise<void> | void; after?: (write: Write) => Promise<void> | void } = {};
  const copy = (item: GraphItem) => structuredClone(item);
  function requireNode(id: string) {
    const node = nodes.get(id);
    if (!node) throw new GraphError('Missing item', { status: 404, code: 'itemNotFound' });
    return node;
  }
  function child(parent: string, name: string) {
    return [...nodes.values()].find(node => node.parent === parent && node.item.name.toLowerCase() === name.toLowerCase());
  }
  function put(parent: string, name: string, text: string, isFolder = false): GraphItem {
    const previous = child(parent, name);
    const id = previous?.item.id ?? `item-${++sequence}`;
    const item: GraphItem = { id, name, eTag: `"revision-${++sequence}"`, ...(isFolder ? { folder: {} } : { file: {} }), parentReference: { id: parent } };
    nodes.set(id, { item, parent, text });
    return copy(item);
  }
  const graph: GraphClient = {
    driveId: async () => 'drive',
    root: async () => copy(folder),
    getItem: async id => id === folder.id ? copy(folder) : copy(requireNode(id).item),
    children: async id => [...nodes.values()].filter(node => node.parent === id).map(node => copy(node.item)),
    findChild: async (id, name) => { const found = child(id, name); return found ? copy(found.item) : null; },
    createFolder: async (parent, name) => {
      if (child(parent, name)) throw new GraphError('Name collision', { status: 409, code: 'nameAlreadyExists' });
      return put(parent, name, '', true);
    },
    readText: async id => { reads.push(id); const node = requireNode(id); return { id, text: node.text, revision: node.item.eTag! }; },
    createFile: async (parent, name, text) => {
      const write: Write = { kind: 'create', id: '', parent, name, text };
      await hooks.before?.(write);
      if (child(parent, name)) throw new GraphError('Name collision', { status: 409, code: 'nameAlreadyExists' });
      const saved = put(parent, name, text);
      write.id = saved.id;
      committed.push({ ...write });
      await hooks.after?.(write);
      return saved;
    },
    replaceText: async (id, revision, text) => {
      const current = requireNode(id);
      const write: Write = { kind: 'replace', id, parent: current.parent, name: current.item.name, text, revision };
      await hooks.before?.(write);
      const latest = requireNode(id);
      if (latest.item.eTag !== revision) throw new GraphError('Revision changed', { status: 412, code: 'preconditionFailed' });
      const saved = put(latest.parent, latest.item.name, text);
      committed.push({ ...write });
      await hooks.after?.(write);
      return saved;
    },
  };
  const store = () => {
    const values = new Map();
    return createOneDriveStore(graph, folder, parse, {
      get: async name => values.get(name),
      put: async (name, value) => { values.set(name, value); },
      clear: async () => { values.clear(); },
    });
  };
  return { graph, folder, hooks, committed, reads, store, put,
    move: (id: string, parent: string) => { requireNode(id).parent = parent; requireNode(id).item.parentReference = { id: parent }; },
    text: (parent: string, name: string) => child(parent, name)?.text,
  };
}

test('load recursively reads Markdown and excludes archives, dot entries and other file types', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Root'));
  const nested = f.put('root', 'nested', '', true);
  f.put(nested.id, 'notes.MD', entry('Nested'));
  f.put('root', 'removed.md', entry('Archived'));
  f.put(nested.id, 'REMOVED.md', entry('Also archived'));
  f.put('root', '.hidden.md', entry('Hidden'));
  const hidden = f.put('root', '.private', '', true);
  f.put(hidden.id, 'secret.md', entry('Hidden folder'));
  f.put('root', 'image.png', 'not Markdown');
  const deck = await f.store().load();
  assert.deepEqual(deck.files, ['deck.md', 'nested/notes.MD']);
  assert.deepEqual(deck.cards.map(card => card.question), ['Root', 'Nested']);
  assert.deepEqual(deck.errors, []);
  assert.equal(Object.keys(deck.revisions).length, 2);
});

test('load reports malformed card files and suppresses the incomplete practice deck', async () => {
  const f = fixture();
  f.put('root', 'good.md', entry('Valid'));
  f.put('root', 'bad.md', '# question\nMissing answer');
  const deck = await f.store().load();
  assert.deepEqual(deck.cards, []);
  assert.deepEqual(deck.files, ['bad.md', 'good.md']);
  assert.equal(deck.errors.length, 1);
  assert.match(deck.errors[0], /bad\.md:1/);
});

test('add creation collision rebases onto the newly existing file without importing external cards into the snapshot', async () => {
  const f = fixture();
  const store = f.store();
  const deck = await store.load();
  let collided = false;
  f.hooks.before = write => {
    if (write.name === 'new_cards.md' && !collided) {
      collided = true;
      f.put('root', 'new_cards.md', entry('External'));
    }
  };
  const updated = await store.mutate({ action: 'add', source: 'new_cards.md', revision: null, question: 'Mine', answer: 'Answer' }, deck);
  assert.equal(f.text('root', 'new_cards.md'), entry('External') + entry('Mine'));
  assert.deepEqual(updated.cards.map(card => card.question), ['Mine']);
  assert.deepEqual(deck.cards, []);
});

test('add CAS conflict rereads latest source and preserves a concurrent external update', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Original'));
  const store = f.store();
  const deck = await store.load();
  let raced = false;
  f.hooks.before = write => {
    if (write.name === 'deck.md' && !raced) {
      raced = true;
      f.put('root', 'deck.md', entry('Original') + entry('External addition'));
    }
  };
  const updated = await store.mutate({ action: 'add', source: 'deck.md', revision: deck.revisions['deck.md'], question: 'Mine', answer: 'Answer' }, deck);
  assert.equal(f.text('root', 'deck.md'), entry('Original') + entry('External addition') + entry('Mine'));
  assert.deepEqual(updated.cards.map(card => card.question), ['Original', 'Mine']);
  assert.equal(updated.cards[0], deck.cards[0]);
});

test('edit conflict updates all matching cards added by another editor', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Original'));
  const store = f.store();
  const deck = await store.load();
  let raced = false;
  f.hooks.before = write => {
    if (write.name === 'deck.md' && !raced) {
      raced = true;
      f.put('root', 'deck.md', entry('Original') + entry('Original'));
    }
  };
  await store.mutate({ action: 'edit', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0, question: 'Changed', answer: 'Answer' }, deck);
  assert.equal(f.text('root', 'deck.md'), entry('Changed') + entry('Changed'));
});

test('edit updates all source duplicates while preserving other files and snapshot-only membership', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Same') + entry('Other') + entry('Same'));
  f.put('root', 'elsewhere.md', entry('Same'));
  const store = f.store();
  const deck = await store.load();
  f.put('root', 'deck.md', entry('Same') + entry('Other') + entry('Same') + entry('External'));
  f.put('root', 'new_external.md', entry('Unseen file'));
  const updated = await store.mutate({ action: 'edit', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0, question: 'Changed', answer: 'New' }, deck);
  assert.equal(f.text('root', 'deck.md'), entry('Changed', 'New') + entry('Other') + entry('Changed', 'New') + entry('External'));
  assert.equal(f.text('root', 'elsewhere.md'), entry('Same'));
  assert.deepEqual(updated.cards.filter(card => card.source === 'deck.md').map(card => card.question), ['Changed', 'Other', 'Changed']);
  assert.deepEqual(updated.files, deck.files);
  assert.equal(updated.cards.find(card => card.source === 'elsewhere.md'), deck.cards.find(card => card.source === 'elsewhere.md'));
  assert.deepEqual(updated.cards.filter(card => card.source === 'deck.md').map(card => card.id), deck.cards.filter(card => card.source === 'deck.md').map(card => card.id));
  assert.equal(deck.cards[0].question, 'Same');
});

test('unchanged edit performs no OneDrive writes', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Same') + entry('Same'));
  const store = f.store();
  const deck = await store.load();
  const result = await store.mutate({ action: 'edit', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0, question: 'Same', answer: 'Answer' }, deck);
  assert.equal(result, deck);
  assert.deepEqual(f.committed, []);
  assert.equal(f.text('root', JOURNAL), undefined);
});

test('persistent add with lost response is reviewed instead of replayed', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old'));
  let store = f.store();
  const deck = await store.load();
  const request = { action: 'add' as const, source: 'deck.md', revision: deck.revisions['deck.md'], question: 'New', answer: 'Answer' };
  const item: StoredMutation = { id: 'op-add', createdAt: 1, destination: { provider: 'onedrive', driveId: 'drive', folderId: 'root' }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  let saved = structuredClone(item);
  const checkpoint = async (value: StoredMutation) => { saved = structuredClone(value); };
  f.hooks.after = write => { if (write.name === 'deck.md') throw new GraphError('response lost', { status: 0, code: 'networkError' }, true); };
  await assert.rejects(store.execute(item, checkpoint), /response lost/);
  assert.equal(saved.stage, 'source-writing');
  f.hooks.after = undefined;
  store = f.store();
  await store.load();
  await assert.rejects(store.execute(saved, checkpoint), /may still be in flight/);
  assert.equal(f.text('root', 'deck.md'), entry('Old') + entry('New'));
  assert.equal(f.committed.filter(write => write.name === 'deck.md').length, 1);
});

test('persistent edit with an interrupted write remains blocked after reload', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old') + entry('New') + entry('Old'));
  let store = f.store();
  const deck = await store.load();
  const request = { action: 'edit' as const, source: 'deck.md', revision: deck.revisions['deck.md'], index: 0, question: 'New', answer: 'Answer' };
  const item: StoredMutation = { id: 'op-edit', createdAt: 1, destination: { provider: 'onedrive', driveId: 'drive', folderId: 'root' }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  let saved = structuredClone(item);
  const checkpoint = async (value: StoredMutation) => { saved = structuredClone(value); };
  f.hooks.after = write => { if (write.name === 'deck.md') throw new GraphError('response lost', { status: 0, code: 'networkError' }, true); };
  await assert.rejects(store.execute(item, checkpoint), /response lost/);
  f.hooks.after = undefined;
  store = f.store();
  await store.load();
  await assert.rejects(store.execute(saved, checkpoint), /may still be in flight/);
  assert.equal(f.text('root', 'deck.md'), entry('New') + entry('New') + entry('New'));
  assert.equal(f.committed.filter(write => write.name === 'deck.md').length, 1);
});

test('persistent removal with an interrupted archive stays blocked without another write', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old'));
  let store = f.store();
  const deck = await store.load();
  const request = { action: 'remove' as const, source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 };
  const item: StoredMutation = { id: 'op-remove', createdAt: 1, destination: { provider: 'onedrive', driveId: 'drive', folderId: 'root' }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  let saved = structuredClone(item);
  const checkpoint = async (value: StoredMutation) => { saved = structuredClone(value); };
  f.hooks.after = write => { if (write.name === 'removed.md') throw new GraphError('response lost', { status: 0, code: 'networkError' }, true); };
  await assert.rejects(store.execute(item, checkpoint), /response lost/);
  f.hooks.after = undefined;
  store = f.store();
  await store.load();
  await assert.rejects(store.execute(saved, checkpoint), /may still be in flight/);
  assert.equal(f.text('root', 'deck.md'), entry('Old'));
  assert.equal(f.text('root', 'removed.md'), entry('Old'));
  assert.equal(f.committed.filter(write => write.name === 'removed.md').length, 1);
});

test('removal stays blocked even if the source is absent after an interrupted archive', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old'));
  let store = f.store();
  const deck = await store.load();
  const request = { action: 'remove' as const, source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 };
  const item: StoredMutation = { id: 'archive-lost-source-absent', createdAt: 1, destination: { provider: 'onedrive', driveId: 'drive', folderId: 'root' }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  let saved = structuredClone(item);
  const checkpoint = async (value: StoredMutation) => { saved = structuredClone(value); };
  f.hooks.after = write => { if (write.name === 'removed.md') throw new GraphError('response lost', { status: 0, code: 'networkError' }, true); };
  await assert.rejects(store.execute(item, checkpoint), /response lost/);
  f.hooks.after = undefined;
  f.put('root', 'deck.md', '');
  store = f.store();
  await store.load();
  await assert.rejects(store.execute(saved, checkpoint), /may still be in flight/);
  assert.equal(f.committed.filter(write => write.name === 'deck.md').length, 0);
});

test('persistent add does not retry when the lost response preceded commit', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old'));
  const store = f.store();
  const deck = await store.load();
  const request = { action: 'add' as const, source: 'deck.md', revision: deck.revisions['deck.md'], question: 'New', answer: 'Answer' };
  const item: StoredMutation = { id: 'precommit', createdAt: 1, destination: { provider: 'onedrive', driveId: 'drive', folderId: 'root' }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  let failed = false;
  f.hooks.before = write => { if (write.name === 'deck.md' && !failed) { failed = true; throw new GraphError('network', { status: 0, code: 'networkError' }, true); } };
  await assert.rejects(store.execute(item, async () => {}), /network/);
  await assert.rejects(store.execute(item, async () => {}), /may still be in flight/);
  assert.equal(f.text('root', 'deck.md'), entry('Old'));
  assert.equal(f.committed.filter(write => write.name === 'deck.md').length, 0);
});

test('persistent add replans a definite conflict and preserves the external addition', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old'));
  const store = f.store();
  const deck = await store.load();
  const request = { action: 'add' as const, source: 'deck.md', revision: deck.revisions['deck.md'], question: 'New', answer: 'Answer' };
  const item: StoredMutation = { id: 'replan', createdAt: 1, destination: { provider: 'onedrive', driveId: 'drive', folderId: 'root' }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  let raced = false;
  f.hooks.before = write => { if (write.name === 'deck.md' && !raced) { raced = true; f.put('root', 'deck.md', entry('Old') + entry('External')); } };
  await store.execute(item, async () => {});
  assert.equal(f.text('root', 'deck.md'), entry('Old') + entry('External') + entry('New'));
});

test('persistent removal does not replay a lost source response with an identical archive entry', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old'));
  f.put('root', 'removed.md', entry('Old'));
  let store = f.store();
  const deck = await store.load();
  const request = { action: 'remove' as const, source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 };
  const item: StoredMutation = { id: 'source-lost', createdAt: 1, destination: { provider: 'onedrive', driveId: 'drive', folderId: 'root' }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  let saved = structuredClone(item);
  const checkpoint = async (value: StoredMutation) => { saved = structuredClone(value); };
  f.hooks.after = write => { if (write.name === 'deck.md') throw new GraphError('network', { status: 0, code: 'networkError' }, true); };
  await assert.rejects(store.execute(item, checkpoint), /network/);
  f.hooks.after = undefined;
  store = f.store();
  await store.load();
  await assert.rejects(store.execute(saved, checkpoint), /may still be in flight/);
  assert.equal(f.text('root', 'deck.md'), '');
  assert.equal(f.text('root', 'removed.md'), entry('Old'));
  assert.equal(f.committed.filter(write => write.name === 'deck.md').length, 1);
  assert.equal(f.committed.filter(write => write.name === 'removed.md').length, 0);
});

test('remove archives exact CRLF duplicate bytes before deleting any source occurrence', async () => {
  const f = fixture();
  const duplicate = entry('Same').replaceAll('\n', '\r\n');
  const remaining = entry('Other').replaceAll('\n', '\r\n');
  f.put('root', 'deck.md', duplicate + remaining + duplicate);
  const store = f.store();
  const deck = await store.load();
  f.hooks.before = write => {
    if (write.name === 'deck.md') assert.equal(f.text('root', 'removed.md'), duplicate);
  };
  const updated = await store.mutate({ action: 'remove', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 }, deck);
  assert.equal(f.text('root', 'deck.md'), remaining);
  assert.equal(f.text('root', 'removed.md'), duplicate);
  assert.deepEqual(updated.cards.map(card => card.question), ['Other']);
  assert.deepEqual(updated.files, ['deck.md']);
});

test('nested source cards remain editable', async () => {
  const f = fixture();
  const nested = f.put('root', 'nested', '', true);
  f.put(nested.id, 'deck.md', entry('Original'));
  const store = f.store();
  const deck = await store.load();
  const updated = await store.mutate({ action: 'edit', source: 'nested/deck.md', revision: deck.revisions['nested/deck.md'], index: 0, question: 'Changed', answer: 'New' }, deck);
  assert.equal(f.text(nested.id, 'deck.md'), entry('Changed', 'New'));
  assert.equal(updated.cards[0].question, 'Changed');
});


test('refuses to edit a source moved out of the selected folder', async () => {
  const f = fixture();
  const item = f.put('root', 'deck.md', entry('Original'));
  const store = f.store();
  const deck = await store.load();
  f.move(item.id, 'elsewhere');
  await assert.rejects(store.mutate({ action: 'edit', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0, question: 'Changed', answer: 'Answer' }, deck), /moved, renamed, or replaced/);
  assert.equal(f.text('elsewhere', 'deck.md'), entry('Original'));
});


test('hidden files do not block saves or get modified', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old'));
  const old = JSON.stringify({ version: 1, operation: { id: 'old' } });
  f.put('root', JOURNAL, old);
  const store = f.store();
  const deck = await store.load();
  await store.mutate({ action: 'add', source: 'deck.md', revision: deck.revisions['deck.md'], question: 'New', answer: 'Answer' }, deck);
  assert.equal(f.text('root', JOURNAL), old);
  assert.equal(f.text('root', 'deck.md'), entry('Old') + entry('New'));
});

test('missing edit or remove target leaves current source and archive untouched', async () => {
  for (const action of ['edit', 'remove'] as const) {
    const f = fixture();
    f.put('root', 'deck.md', entry('Old'));
    const store = f.store();
    const deck = await store.load();
    f.put('root', 'deck.md', entry('External'));
    const request = action === 'edit'
      ? { action, source: 'deck.md', revision: deck.revisions['deck.md'], index: 0, question: 'New', answer: 'Answer' }
      : { action, source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 };
    await store.mutate(request, deck);
    assert.equal(f.text('root', 'deck.md'), entry('External'));
    assert.equal(f.text('root', 'removed.md'), action === 'remove' ? entry('Old') : undefined);
    assert.equal(f.committed.filter(write => write.name === 'deck.md').length, 0);
  }
});

test('remove rebases after a source conflict and archives only once', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old'));
  const store = f.store();
  const deck = await store.load();
  let raced = false;
  f.hooks.before = write => {
    if (write.name === 'deck.md' && !raced) {
      raced = true;
      f.put('root', 'deck.md', entry('Old') + entry('Old') + entry('Other'));
    }
  };
  await store.mutate({ action: 'remove', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 }, deck);
  assert.equal(f.text('root', 'deck.md'), entry('Other'));
  assert.equal(f.text('root', 'removed.md'), entry('Old'));
});


test('first source and archive writes use initialized snapshots without downloading again', async () => {
  const f = fixture();
  const source = f.put('root', 'deck.md', entry('Old'));
  const archive = f.put('root', 'removed.md', entry('Previous'));
  const store = f.store();
  const deck = await store.load();
  f.reads.length = 0;
  let firstWrite = true;
  f.hooks.before = () => {
    if (firstWrite) {
      assert.equal(f.reads.includes(source.id), false);
      assert.equal(f.reads.includes(archive.id), false);
      firstWrite = false;
    }
  };
  await store.mutate({ action: 'remove', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 }, deck);
  assert.equal(firstWrite, false);
});

test('refreshes a cached archive no-op before removing the source', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old'));
  f.put('root', 'removed.md', entry('Old'));
  const store = f.store();
  const deck = await store.load();
  f.put('root', 'removed.md', entry('Other'));
  await store.mutate({ action: 'remove', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 }, deck);
  assert.equal(f.text('root', 'removed.md'), entry('Other') + entry('Old'));
  assert.equal(f.text('root', 'deck.md'), '');
});

test('successful first write does not download the source again', async () => {
  const f = fixture();
  const source = f.put('root', 'deck.md', entry('Old'));
  const store = f.store();
  const deck = await store.load();
  f.reads.length = 0;
  await store.mutate({ action: 'add', source: 'deck.md', revision: deck.revisions['deck.md'], question: 'New', answer: 'Answer' }, deck);
  assert.equal(f.reads.includes(source.id), false);
});

test('repeated source conflicts retain a replanned retryable operation', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old'));
  const store = f.store();
  const deck = await store.load();
  const request = { action: 'add' as const, source: 'deck.md', revision: deck.revisions['deck.md'], question: 'New', answer: 'Answer' };
  const item: StoredMutation = { id: 'retry-conflict', createdAt: 1, destination: { provider: 'onedrive', driveId: 'drive', folderId: 'root' }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  f.hooks.before = write => { if (write.name === 'deck.md') throw new GraphError('stale', { status: 412, code: 'preconditionFailed' }); };
  await assert.rejects(store.execute(item, async () => {}), error => error instanceof DeckRequestError && error.cause instanceof GraphError && error.cause.code === 'retryableConflict');
  assert.equal(item.stage, 'source-ready');
  f.hooks.before = undefined;
  await store.execute(item, async () => {});
  assert.equal(f.text('root', 'deck.md'), entry('Old') + entry('New'));
});

test('repeated archive conflicts retain a retryable removal', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Old'));
  f.put('root', 'removed.md', entry('Other'));
  const store = f.store();
  const deck = await store.load();
  const request = { action: 'remove' as const, source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 };
  const item: StoredMutation = { id: 'retry-archive', createdAt: 1, destination: { provider: 'onedrive', driveId: 'drive', folderId: 'root' }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  f.hooks.before = write => { if (write.name === 'removed.md') throw new GraphError('stale', { status: 412, code: 'preconditionFailed' }); };
  await assert.rejects(store.execute(item, async () => {}), error => error instanceof DeckRequestError && error.cause instanceof GraphError && error.cause.code === 'retryableConflict');
  assert.equal(item.stage, 'archive-ready');
  assert.equal(f.text('root', 'deck.md'), entry('Old'));
  f.hooks.before = undefined;
  await store.execute(item, async () => {});
  assert.equal(f.text('root', 'deck.md'), '');
  assert.equal(f.text('root', 'removed.md'), entry('Other') + entry('Old'));
});
