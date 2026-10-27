import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './support/temporary-directory.ts';
import { createDeckStore } from '../server/deck.js';

const valid = (question: string) => `# question\n${question}\n# answer\nAnswer`;

test('explicit loads read external entry/file changes without modifying previous snapshots', async t => {
  const directory = await temporaryDirectory(t);
  await mkdir(path.join(directory, 'nested'));
  const file = path.join(directory, 'nested', 'deck.md');
  await writeFile(file, valid('One'));
  const store = await createDeckStore(directory);
  const original = await store.getState();
  assert.deepEqual(original.files, ['nested/deck.md']);
  await writeFile(path.join(directory, 'ignore.txt'), '# answer');
  await writeFile(file, valid('Two') + '\n\n' + valid('Three'));
  const edited = await store.getState();
  assert.deepEqual(edited.cards.map(card => card.question), ['Two', 'Three']);
  assert.equal(original.cards[0].question, 'One');
  assert.equal(original.cards.length, 1);
  await writeFile(file, valid('Three'));
  assert.equal((await store.getState()).cards.length, 1);
  const added = path.join(directory, 'new.md');
  await writeFile(added, valid('New file'));
  assert.deepEqual((await store.getState()).files, ['nested/deck.md', 'new.md']);
  await writeFile(file, '# question\nUnfinished');
  const invalid = await store.getState();
  assert.equal(invalid.cards.length, 0);
  assert.match(invalid.errors[0], /nested\/deck.md:1/);
  assert.equal(edited.errors.length, 0);
  await writeFile(file, valid('Recovered'));
  assert.equal((await store.getState()).errors.length, 0);
  await rm(file);
  await rm(added);
  assert.deepEqual((await store.getState()).files, []);
});

test('missing materials path fails explicitly', async () => {
  await assert.rejects(createDeckStore('/nonexistent-flashcards-directory'), /ENOENT/);
});

test('refresh reads linked root, file and subfolder changes', async t => {
  const directory = await temporaryDirectory(t);
  const root = path.join(directory, 'materials');
  const target = path.join(directory, 'target');
  const external = path.join(directory, 'external');
  await mkdir(target);
  await mkdir(external);
  const linkedFile = path.join(directory, 'source.md');
  const nestedFile = path.join(external, 'nested.md');
  await writeFile(linkedFile, valid('File'));
  await writeFile(nestedFile, valid('Nested'));
  await symlink(target, root);
  await symlink(linkedFile, path.join(target, 'linked.md'));
  await symlink(external, path.join(target, 'folder'));
  const store = await createDeckStore(root);
  const original = await store.getState();
  assert.deepEqual(original.files, ['folder/nested.md', 'linked.md']);
  await writeFile(linkedFile, valid('Updated file'));
  await writeFile(nestedFile, valid('Updated nested'));
  await writeFile(path.join(external, 'new.md'), valid('Added nested'));
  assert.deepEqual((await store.getState()).cards.map(card => card.question),
    ['Updated nested', 'Added nested', 'Updated file']);
  assert.deepEqual(original.cards.map(card => card.question), ['Nested', 'File']);
});
