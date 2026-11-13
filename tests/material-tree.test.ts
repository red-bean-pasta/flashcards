import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMaterialTree } from '../src/lib/material-tree.ts';

test('buildMaterialTree organizes files into sorted hierarchical folder and file nodes', () => {
  const files = ['A1.md', 'A2.md', 'B/B1.md', 'B/B2.md', 'B/BA1/deep.md', 'C/C1.md'];
  const tree = buildMaterialTree(files);

  assert.equal(tree.path, '');
  assert.deepEqual(tree.folders.map(f => f.name), ['B', 'C']);
  assert.deepEqual(tree.folders.map(f => f.path), ['B/', 'C/']);
  assert.deepEqual(tree.files.map(f => f.name), ['A1', 'A2']);
  assert.deepEqual(tree.files.map(f => f.path), ['A1.md', 'A2.md']);

  const folderB = tree.folders[0];
  assert.equal(folderB.name, 'B');
  assert.equal(folderB.path, 'B/');
  assert.deepEqual(folderB.folders.map(f => f.name), ['BA1']);
  assert.deepEqual(folderB.folders.map(f => f.path), ['B/BA1/']);
  assert.deepEqual(folderB.files.map(f => f.name), ['B1', 'B2']);
  assert.deepEqual(folderB.files.map(f => f.path), ['B/B1.md', 'B/B2.md']);

  const folderBA1 = folderB.folders[0];
  assert.equal(folderBA1.name, 'BA1');
  assert.equal(folderBA1.path, 'B/BA1/');
  assert.deepEqual(folderBA1.folders, []);
  assert.deepEqual(folderBA1.files.map(f => f.name), ['Deep']);
  assert.deepEqual(folderBA1.files.map(f => f.path), ['B/BA1/deep.md']);

  const folderC = tree.folders[1];
  assert.equal(folderC.name, 'C');
  assert.equal(folderC.path, 'C/');
  assert.deepEqual(folderC.folders, []);
  assert.deepEqual(folderC.files.map(f => f.name), ['C1']);
  assert.deepEqual(folderC.files.map(f => f.path), ['C/C1.md']);
});

test('buildMaterialTree handles empty file list and flat files without subfolders', () => {
  assert.deepEqual(buildMaterialTree([]), { name: 'Root', path: '', folders: [], files: [] });

  const flat = buildMaterialTree(['zebra.md', 'alpha.md']);
  assert.deepEqual(flat.folders, []);
  assert.deepEqual(flat.files.map(f => f.name), ['Alpha', 'Zebra']);
});
