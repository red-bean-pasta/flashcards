import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMaterialLoader } from '../server/materials.js';
import { MaterialReadError, readMaterial, scanMarkdown } from '../server/filesystem.js';

test('malformed material is recoverable, but parser/renderer bugs retain identity and cause', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flashcards-errors-'));
  try {
    await writeFile(path.join(directory, 'deck.md'), '# question\nIncomplete');
    const state = await createMaterialLoader(directory).load();
    assert.equal(state.cards.length, 0);
    assert.match(state.errors[0], /deck.md:1:/);
    const failure = new TypeError('Unexpected rendering failure', { cause: new Error('original cause') });
    const loader = createMaterialLoader(directory, () => { throw failure; });
    await assert.rejects(loader.load(), error => error === failure);
    assert.equal(failure.cause instanceof Error && failure.cause.message, 'original cause');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('filesystem failures retain cause at the read boundary and become explicit diagnostics', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flashcards-filesystem-'));
  await rm(directory, { recursive: true });
  await assert.rejects(readMaterial(path.join(directory, 'missing.md'), 'missing.md'), error => {
    assert.ok(error instanceof MaterialReadError);
    assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT');
    return true;
  });
  const state = await createMaterialLoader(directory).load();
  assert.equal(state.cards.length, 0);
  assert.match(state.errors[0], /ENOENT/);
});

const validCard = '# question\nQuestion\n# answer\nAnswer';

test('symlink roots, files and folders preserve logical paths and skip non-md files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flashcards-links-'));
  try {
    const target = path.join(directory, 'target');
    const root = path.join(directory, 'materials');
    await mkdir(target);
    await mkdir(path.join(directory, 'external'));
    await writeFile(path.join(directory, 'source.txt'), validCard);
    await writeFile(path.join(directory, 'external', 'nested.MD'), validCard);
    await writeFile(path.join(target, 'ignored.txt'), '# answer');
    await symlink(target, root);
    await symlink('../source.txt', path.join(target, 'linked.md'));
    await symlink('../source.txt', path.join(target, 'ignored-link.txt'));
    await symlink('../external', path.join(target, 'folder'));
    const state = await createMaterialLoader(root).load();
    assert.deepEqual(state.errors, []);
    assert.deepEqual(state.files, ['folder/nested.MD', 'linked.md']);
    assert.equal(state.cards.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recursive directory links throw and produce an explicit loader diagnostic', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flashcards-cycle-'));
  try {
    const cycle = path.join(directory, 'cycle');
    await writeFile(path.join(directory, 'valid.md'), validCard);
    await symlink(directory, cycle);
    await assert.rejects(scanMarkdown(directory), error => {
      assert.equal((error as NodeJS.ErrnoException).code, 'ELOOP');
      assert.equal((error as NodeJS.ErrnoException).path, cycle);
      assert.match((error as Error).message, /Recursive directory link/);
      return true;
    });
    const state = await createMaterialLoader(directory).load();
    assert.deepEqual(state.cards, []);
    assert.deepEqual(state.files, []);
    assert.equal(state.errors.length, 1);
    assert.ok(state.errors[0].includes(cycle));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('broken material links produce an explicit filesystem diagnostic', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flashcards-broken-link-'));
  try {
    await symlink('missing.md', path.join(directory, 'broken.md'));
    const state = await createMaterialLoader(directory).load();
    assert.match(state.errors[0], /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
