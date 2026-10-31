import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFolderConnection } from '../src/lib/onedrive/connection.ts';
import { createFolderMemory } from '../src/lib/onedrive/folder-memory.ts';
import type { GraphClient, GraphItem } from '../src/lib/onedrive/graph.ts';

const root: GraphItem = { id: 'root', name: 'OneDrive', folder: {} };

test('select publishes the chosen folder and persistent destination together', async () => {
  const graph = { root: async () => root, driveId: async () => 'drive' } as GraphClient;
  let remembered = '';
  const states: any[] = [];
  const connection = createFolderConnection(graph, { remember(id) { remembered = id; }, recall() { return null; } }, state => states.push(state));
  const folder: GraphItem = { id: 'folder', name: 'Cards', folder: {} };
  await connection.select(folder);
  assert.equal(remembered, 'folder');
  assert.equal(states[0].folder, folder);
  assert.deepEqual(states[0].backend.persistent.destination, { provider: 'onedrive', driveId: 'drive', folderId: 'folder' });
});

test('failed folder selection leaves the previous backend intact', async () => {
  let fail = false;
  const graph = { root: async () => { if (fail) throw new Error('offline'); return root; }, driveId: async () => 'drive' } as GraphClient;
  const states: any[] = [];
  const connection = createFolderConnection(graph, { remember() {}, recall() { return null; } }, state => states.push(state));
  await connection.select({ id: 'a', name: 'A', folder: {} });
  fail = true;
  await assert.rejects(connection.select({ id: 'b', name: 'B', folder: {} }), /offline/);
  assert.equal(states.length, 1);
  assert.equal(states[0].folder.id, 'a');
});

test('folder memory reports unavailable storage', () => {
  const unavailable = new DOMException('blocked', 'SecurityError');
  const memory = createFolderMemory('client', () => { throw unavailable; });
  assert.throws(() => memory.recall('root'), error => error instanceof Error && error.cause === unavailable);
  assert.throws(() => memory.remember('A', 'root'), error => error instanceof Error && error.cause === unavailable);
});

test('default and old folder memory resolve to the app root', async () => {
  const graph = { root: async () => root, driveId: async () => 'drive' } as GraphClient;
  const storage = new Map<string, string>();
  const memory = createFolderMemory('client', () => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } }));
  memory.remember('old-folder', 'old-drive-root');
  const states: any[] = [];
  const connection = createFolderConnection(graph, memory, state => states.push(state));
  await connection.restore();
  assert.equal(states[0].folder.id, root.id);
  assert.equal(memory.recall(root.id), root.id);
});
