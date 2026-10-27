import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './support/temporary-directory.ts';
import { parseCards } from '../server/parser.js';
import { materialRevision } from '../server/revision.js';
import { createMaterialLoader } from '../server/materials.js';
import { MaterialReadError, readMaterial, scanMarkdown } from '../server/filesystem.js';

test('malformed material is recoverable, but parser/renderer bugs retain identity and cause', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, 'deck.md'), '# question\nIncomplete');
  const state = await createMaterialLoader(directory).load();
  assert.equal(state.cards.length, 0);
  assert.match(state.errors[0], /deck.md:1:/);
  const failure = new TypeError('Unexpected rendering failure', { cause: new Error('original cause') });
  const loader = createMaterialLoader(directory, () => { throw failure; });
  await assert.rejects(loader.load(), error => error === failure);
  assert.equal(failure.cause instanceof Error && failure.cause.message, 'original cause');
});

test('filesystem failures retain cause at the read boundary and become explicit diagnostics', async t => {
  const directory = await temporaryDirectory(t);
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

test('symlink roots, files and folders preserve logical paths and skip non-md files', async t => {
  const directory = await temporaryDirectory(t);
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
});

test('recursive directory links throw and produce an explicit loader diagnostic', async t => {
  const directory = await temporaryDirectory(t);
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
});

test('broken material links produce an explicit filesystem diagnostic', async t => {
  const directory = await temporaryDirectory(t);
  await symlink('missing.md', path.join(directory, 'broken.md'));
  const state = await createMaterialLoader(directory).load();
  assert.match(state.errors[0], /ENOENT/);
});

test('cached material revisions track raw text even when normalized cards stay identical', async t => {
  const directory = await temporaryDirectory(t);
  const filename = path.join(directory, 'deck.md');
  const text = '# question\nQ\n# answer\nA';
  let parses = 0;
  const loader = createMaterialLoader(directory, (input, source) => {
    parses += 1;
    return parseCards(input, source);
  });
  await writeFile(filename, text);
  const initial = await loader.load();
  const cached = await loader.load();
  assert.equal(parses, 1);
  assert.equal(cached.revisions['deck.md'], materialRevision(text));
  assert.equal(cached.cards[0], initial.cards[0]);
  const changed = text.replaceAll('\n', '\r\n');
  await writeFile(filename, changed);
  const refreshed = await loader.load();
  assert.equal(parses, 2);
  assert.deepEqual(refreshed.cards, initial.cards);
  assert.equal(refreshed.revisions['deck.md'], materialRevision(changed));
  assert.notEqual(refreshed.revisions['deck.md'], initial.revisions['deck.md']);
});
