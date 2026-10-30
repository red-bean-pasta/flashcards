import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalFolderBackend } from '../src/lib/local-folder.ts';
import { parseBrowserCards } from '../src/lib/browser-cards.ts';

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
  await assert.rejects(backend.mutate({ action: 'remove', source: 'nested/notes.md', index: 0, revision: null }, deck), /does not support write/);
});

test('read-only folder name comes from the selected root path', async () => {
  const { selectedFolderName } = await import('../src/lib/local-folder-readonly.ts');
  const files = { item: () => ({ webkitRelativePath: 'My notes/subfolder/notes.md' }) } as unknown as FileList;
  assert.equal(selectedFolderName(files), 'My notes');
  assert.throws(() => selectedFolderName({ item: () => ({ webkitRelativePath: 'notes.md' }) } as unknown as FileList), /relative path/);
});
