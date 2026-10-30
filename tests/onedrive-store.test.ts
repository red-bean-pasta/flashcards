import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBrowserCards } from '../src/lib/browser-cards.ts';
import { DeckRequestError } from '../src/lib/deck-client.ts';
import { GraphError } from '../src/lib/onedrive/graph.ts';
import type { GraphClient, GraphItem } from '../src/lib/onedrive/graph.ts';
import { createOneDriveStore } from '../src/lib/onedrive/store.ts';

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
    root: async () => copy(folder),
    getItem: async id => id === folder.id ? copy(folder) : copy(requireNode(id).item),
    children: async id => [...nodes.values()].filter(node => node.parent === id).map(node => copy(node.item)),
    findChild: async (id, name) => { const found = child(id, name); return found ? copy(found.item) : null; },
    createFolder: async (parent, name) => {
      if (child(parent, name)) throw new GraphError('Name collision', { status: 409, code: 'nameAlreadyExists' });
      return put(parent, name, '', true);
    },
    readText: async id => { const node = requireNode(id); return { id, text: node.text, revision: node.item.eTag! }; },
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
  const store = () => createOneDriveStore(graph, folder, parse);
  return { graph, folder, hooks, committed, store, put,
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
  assert.equal(await store.pending(), null);
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

test('remove archives exact CRLF duplicate bytes before deleting any source occurrence', async () => {
  const f = fixture();
  const duplicate = entry('Same').replaceAll('\n', '\r\n');
  const remaining = entry('Other').replaceAll('\n', '\r\n');
  f.put('root', 'deck.md', duplicate + remaining + duplicate);
  const store = f.store();
  const deck = await store.load();
  f.hooks.before = write => {
    if (write.name === 'deck.md') assert.equal(f.text('root', 'removed.md'), duplicate + duplicate);
  };
  const updated = await store.mutate({ action: 'remove', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 }, deck);
  assert.equal(f.text('root', 'deck.md'), remaining);
  assert.equal(f.text('root', 'removed.md'), duplicate + duplicate);
  assert.deepEqual(updated.cards.map(card => card.question), ['Other']);
  assert.deepEqual(updated.files, ['deck.md']);
  assert.equal(await store.pending(), null);
});

test('definite source failure after archival retains recovery intent and safely retries the original CAS', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Remove') + entry('Keep'));
  const store = f.store();
  const deck = await store.load();
  f.hooks.before = write => { if (write.name === 'deck.md') throw new GraphError('Permission temporarily denied', { status: 403, code: 'accessDenied' }); };
  await assert.rejects(store.mutate({ action: 'remove', source: 'deck.md', revision: deck.revisions['deck.md'], index: 0 }, deck), DeckRequestError);
  assert.equal(f.text('root', 'removed.md'), entry('Remove'));
  assert.equal(f.text('root', 'deck.md'), entry('Remove') + entry('Keep'));
  const pending = await store.pending();
  assert.equal(pending?.stage, 'source-writing');
  assert.equal(pending?.sourceWrite.revision, deck.revisions['deck.md']);
  f.hooks.before = undefined;
  await store.recover();
  assert.equal(f.text('root', 'deck.md'), entry('Keep'));
  assert.equal(f.text('root', 'removed.md'), entry('Remove'));
  assert.equal(await store.pending(), null);
});

test('unknown source write that actually committed cannot append again during recovery', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Original'));
  const store = f.store();
  const deck = await store.load();
  f.hooks.after = write => { if (write.name === 'deck.md') throw new GraphError('Save outcome unknown', { status: 0, code: 'networkError' }, true); };
  await assert.rejects(store.mutate({ action: 'add', source: 'deck.md', revision: deck.revisions['deck.md'], question: 'Mine', answer: 'Answer' }, deck), /unknown/);
  assert.equal(f.text('root', 'deck.md'), entry('Original') + entry('Mine'));
  f.hooks.after = undefined;
  await assert.rejects(store.recover(), /cannot be repeated safely/);
  assert.equal(f.text('root', 'deck.md'), entry('Original') + entry('Mine'));
  const pending = await store.pending();
  assert.ok(pending);
  await store.clearReviewed(pending.id);
  assert.equal(await store.pending(), null);
  assert.equal(f.committed.filter(write => write.name === 'deck.md').length, 1);
});

test('interrupted add with no source write recovers the exact prepared bytes and revision', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Original'));
  const store = f.store();
  const deck = await store.load();
  f.hooks.before = write => { if (write.name === 'deck.md') throw new GraphError('Request aborted before sending', { status: 0, code: 'networkError' }, true); };
  await assert.rejects(store.mutate({ action: 'add', source: 'deck.md', revision: deck.revisions['deck.md'], question: 'Mine', answer: 'Answer' }, deck));
  const pending = await store.pending();
  assert.equal(pending?.sourceWrite.revision, deck.revisions['deck.md']);
  assert.equal(f.text('root', 'deck.md'), entry('Original'));
  f.hooks.before = undefined;
  await store.recover();
  const write = f.committed.find(write => write.name === 'deck.md')!;
  assert.equal(write.revision, pending!.sourceWrite.revision);
  assert.equal(write.text, pending!.sourceWrite.after);
  assert.equal(f.text('root', 'deck.md'), entry('Original') + entry('Mine'));
  assert.equal(await store.pending(), null);
});

test('competing stores serialize through no-clobber journal claims', async () => {
  const f = fixture();
  f.put('root', 'deck.md', entry('Original'));
  const first = f.store();
  const second = f.store();
  const firstDeck = await first.load();
  const secondDeck = await second.load();
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let paused = false;
  f.hooks.before = async write => {
    if (write.name === JOURNAL && write.kind === 'create' && !paused) { paused = true; entered(); await gate; }
  };
  const losing = first.mutate({ action: 'add', source: 'deck.md', revision: firstDeck.revisions['deck.md'], question: 'First', answer: 'Answer' }, firstDeck);
  // Attach a rejection observer before allowing the competing write to finish.
  const outcome = losing.then(() => null, error => error);
  await started;
  await second.mutate({ action: 'add', source: 'deck.md', revision: secondDeck.revisions['deck.md'], question: 'Second', answer: 'Answer' }, secondDeck);
  unblock();
  assert.ok(await outcome instanceof DeckRequestError);
  assert.equal(f.text('root', 'deck.md'), entry('Original') + entry('Second'));
  assert.equal(f.committed.filter(write => write.name === 'deck.md').length, 1);
});

test('nested source cards remain editable through the durable operation journal', async () => {
  const f = fixture();
  const nested = f.put('root', 'nested', '', true);
  f.put(nested.id, 'deck.md', entry('Original'));
  const store = f.store();
  const deck = await store.load();
  const updated = await store.mutate({ action: 'edit', source: 'nested/deck.md', revision: deck.revisions['nested/deck.md'], index: 0, question: 'Changed', answer: 'New' }, deck);
  assert.equal(f.text(nested.id, 'deck.md'), entry('Changed', 'New'));
  assert.equal(updated.cards[0].question, 'Changed');
  assert.equal(await store.pending(), null);
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
