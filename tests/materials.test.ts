import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMaterialLoader } from '../server/materials.js';
import { MaterialReadError, readMaterial } from '../server/filesystem.js';

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
