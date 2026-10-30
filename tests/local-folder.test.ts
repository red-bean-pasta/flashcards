import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalFolderBackend } from '../src/lib/local-folder.ts';
import { parseBrowserCards } from '../src/lib/browser-cards.ts';
import { captureOperation } from '../src/lib/onedrive/operations.ts';
import type { StoredMutation } from '../src/lib/mutation-storage.ts';

const entry = '# question\nOne\n\n# answer\nAnswer\n\n';
function directory(name: string) {
  const entries = new Map<string, any>();
  return { kind: 'directory', name, entries, async *values() { yield* entries.values(); },
    async getFileHandle(filename: string, options?: { create?: boolean }) {
      if (!entries.has(filename) && options?.create) entries.set(filename, file(filename, ''));
      if (!entries.has(filename)) throw new DOMException('Missing', 'NotFoundError');
      return entries.get(filename);
    } };
}
function file(name: string, initial: string) {
  let text = initial;
  return { kind: 'file', name, async getFile() { return { text: async () => text, lastModified: 1, size: text.length }; },
    async createWritable() { let next = ''; return { async write(value: string) { next = value; }, async close() { text = next; } }; } };
}

test('local folder scans nested notes and archives removal', async () => {
  const root = directory('root');
  const nested = directory('nested');
  nested.entries.set('notes.md', file('notes.md', entry));
  root.entries.set('nested', nested);
  const backend = createLocalFolderBackend(root as any, (text, source) => parseBrowserCards(text, source, value => value));
  const deck = await backend.load();
  assert.deepEqual(deck.files, ['nested/notes.md']);
  assert.equal(deck.cards[0].question, 'One');
  const next = await backend.mutate({ action: 'remove', source: 'nested/notes.md', index: 0, revision: deck.revisions['nested/notes.md'] }, deck);
  assert.equal(next.cards.length, 0);
  assert.match(await (await root.entries.get('removed.md').getFile()).text(), /One/);
  assert.equal(await (await nested.entries.get('notes.md').getFile()).text(), '');
});

test('unchanged local edit does not open a writable stream', async () => {
  const root = directory('root');
  const note = file('notes.md', entry);
  note.createWritable = async () => { throw new Error('Unexpected write'); };
  root.entries.set('notes.md', note);
  const backend = createLocalFolderBackend(root as any, (text, source) => parseBrowserCards(text, source, value => value));
  const deck = await backend.load();
  const result = await backend.mutate({ action: 'edit', source: 'notes.md', index: 0, revision: deck.revisions['notes.md'], question: ' One ', answer: '\r\nAnswer\r\n' }, deck);
  assert.equal(result, deck);
  assert.equal(await (await note.getFile()).text(), entry);
});

test('local removal resumes after the archive commits and its response is lost', async () => {
  const root = directory('root');
  root.entries.set('notes.md', file('notes.md', entry));
  const archive = file('removed.md', '');
  const originalWritable = archive.createWritable;
  let fail = true;
  archive.createWritable = async () => {
    const stream = await originalWritable();
    return { ...stream, async close() { await stream.close(); if (fail) { fail = false; throw new DOMException('Interrupted', 'NetworkError'); } } };
  };
  root.entries.set('removed.md', archive);
  let backend = createLocalFolderBackend(root as any, (text, source) => parseBrowserCards(text, source, value => value));
  const deck = await backend.load();
  const request = { action: 'remove' as const, source: 'notes.md', index: 0, revision: deck.revisions['notes.md'] };
  const item: StoredMutation = { id: 'local-remove', createdAt: 1, destination: { provider: 'local', folder: root as any }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  let saved = item;
  const checkpoint = async (value: StoredMutation) => { saved = { ...value }; };
  await assert.rejects(backend.persistent.execute(item, checkpoint), /Interrupted/);
  assert.equal(saved.stage, 'archive-writing');
  backend = createLocalFolderBackend(root as any, (text, source) => parseBrowserCards(text, source, value => value));
  await backend.load();
  await backend.persistent.execute(saved, checkpoint);
  assert.equal(await (await archive.getFile()).text(), entry);
  assert.equal(await (await root.entries.get('notes.md').getFile()).text(), '');
});

test('a reloaded local source write is not replayed while an earlier stream may still finish', async () => {
  const root = directory('root');
  root.entries.set('notes.md', file('notes.md', entry));
  const backend = createLocalFolderBackend(root as any, (text, source) => parseBrowserCards(text, source, value => value));
  const deck = await backend.load();
  const request = { action: 'edit' as const, source: 'notes.md', index: 0, revision: deck.revisions['notes.md'], question: 'Changed', answer: 'Answer' };
  const item: StoredMutation = { id: 'local-edit', createdAt: 1, destination: { provider: 'local', folder: root as any }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'source-writing', attempts: 0,
    sourceWrite: { id: 'notes.md', name: 'notes.md', revision: null, before: entry, after: entry.replace('One', 'Changed') } };
  await assert.rejects(backend.persistent.execute(item, async () => {}, true), /may still be finishing/);
  assert.equal(await (await root.entries.get('notes.md').getFile()).text(), entry);
});

test('local removal stops if the source changes after archival', async () => {
  const root = directory('root');
  const source = file('notes.md', entry);
  const archive = file('removed.md', '');
  const originalWritable = archive.createWritable;
  archive.createWritable = async () => {
    const stream = await originalWritable();
    return { ...stream, async close() {
      await stream.close();
      const changed = await source.createWritable();
      await changed.write(entry.replace('One', 'External'));
      await changed.close();
    } };
  };
  root.entries.set('notes.md', source);
  root.entries.set('removed.md', archive);
  const backend = createLocalFolderBackend(root as any, (text, source) => parseBrowserCards(text, source, value => value));
  const deck = await backend.load();
  const request = { action: 'remove' as const, source: 'notes.md', index: 0, revision: deck.revisions['notes.md'] };
  const item: StoredMutation = { id: 'local-change', createdAt: 1, destination: { provider: 'local', folder: root as any }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0 };
  await assert.rejects(backend.persistent.execute(item, async () => {}), /changed before saving/);
  assert.equal(await (await source.getFile()).text(), entry.replace('One', 'External'));
  assert.equal(await (await archive.getFile()).text(), entry);
});

test('a corrupted saved local plan is rejected before opening a writable stream', async () => {
  const root = directory('root');
  const source = file('notes.md', entry);
  source.createWritable = async () => { throw new Error('Unexpected write'); };
  root.entries.set('notes.md', source);
  const backend = createLocalFolderBackend(root as any, (text, source) => parseBrowserCards(text, source, value => value));
  const deck = await backend.load();
  const request = { action: 'add' as const, source: 'notes.md', revision: deck.revisions['notes.md'], question: 'New', answer: 'Answer' };
  const item: StoredMutation = { id: 'bad-plan', createdAt: 1, destination: { provider: 'local', folder: root as any }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'source-ready', attempts: 0,
    sourceWrite: { id: 'notes.md', name: 'notes.md', revision: null, before: entry, after: 'corrupt' } };
  await assert.rejects(backend.persistent.execute(item, async () => {}), /does not match/);
  assert.equal(await (await source.getFile()).text(), entry);
});

test('an impossible local execution stage cannot report success', async () => {
  const root = directory('root');
  root.entries.set('notes.md', file('notes.md', entry));
  const backend = createLocalFolderBackend(root as any, (text, source) => parseBrowserCards(text, source, value => value));
  const deck = await backend.load();
  const request = { action: 'add' as const, source: 'notes.md', revision: deck.revisions['notes.md'], question: 'New', answer: 'Answer' };
  const item: StoredMutation = { id: 'invalid-stage', createdAt: 1, destination: { provider: 'local', folder: root as any }, request, operation: captureOperation(deck, request), snapshot: deck, stage: 'queued', attempts: 0,
    sourceWrite: { id: 'notes.md', name: 'notes.md', revision: null, before: entry, after: entry + '# question\nNew\n\n# answer\nAnswer\n\n' } };
  await assert.rejects(backend.persistent.execute(item, async () => {}), /Unexpected pending local mutation stage/);
  assert.equal(await (await root.entries.get('notes.md').getFile()).text(), entry);
});

test('read-only folder loads selected Markdown and rejects writes', async () => {
  const { createReadOnlyFolderBackend } = await import('../src/lib/local-folder-readonly.ts');
  const selected = [
    { webkitRelativePath: 'Cards/nested/notes.md', text: async () => entry, lastModified: 1, size: entry.length },
    { webkitRelativePath: 'Cards/removed.md', text: async () => entry, lastModified: 1, size: entry.length },
    { webkitRelativePath: 'Cards/.hidden/notes.md', text: async () => entry, lastModified: 1, size: entry.length },
  ] as File[];
  const backend = createReadOnlyFolderBackend(selected, (text, source) => parseBrowserCards(text, source, value => value));
  const deck = await backend.load();
  assert.deepEqual(deck.files, ['nested/notes.md']);
  assert.equal(deck.cards[0].question, 'One');
  await assert.rejects(backend.mutate({ action: 'remove', source: 'nested/notes.md', index: 0, revision: null }, deck), /read-only in your browser/);
});

test('read-only folder name comes from the selected root path', async () => {
  const { selectedFolderName } = await import('../src/lib/local-folder-readonly.ts');
  const files = { item: () => ({ webkitRelativePath: 'My notes/subfolder/notes.md' }) } as unknown as FileList;
  assert.equal(selectedFolderName(files), 'My notes');
  assert.throws(() => selectedFolderName({ item: () => ({ webkitRelativePath: 'notes.md' }) } as unknown as FileList), /relative path/);
});
