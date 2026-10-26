import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeckStore } from '../server/deck.js';
import type { DeckState } from '../src/lib/types.js';

const valid = (question: string) => `# question\n${question}\n# answer\nAnswer`;
test('recursive scanning and live add/change/invalid/recovery/delete', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flashcards-test-'));
  const store = await createDeckStore(directory);
  async function change(action: () => Promise<unknown>, condition: (state: DeckState) => boolean) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Timed out waiting for deck update')); }, 6000);
      const unsubscribe = store.subscribe(state => { if (condition(state)) { clearTimeout(timeout); unsubscribe(); resolve(); } });
      action().catch(error => { clearTimeout(timeout); unsubscribe(); reject(error); });
    });
  }
  try {
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'ignore.txt'), '# answer');
    const file = path.join(directory, 'nested', 'deck.md');
    await change(() => writeFile(file, valid('One')), state => state.cards.length === 1);
    assert.deepEqual(store.getState().files, ['nested/deck.md']);
    await change(() => writeFile(file, valid('Two')), state => state.cards[0]?.question === 'Two');
    await change(() => writeFile(file, '# question\nUnfinished'), state => state.errors.length === 1);
    assert.equal(store.getState().cards.length, 0);
    assert.match(store.getState().errors[0], /nested\/deck.md:1/);
    await change(() => writeFile(file, valid('Recovered')), state => state.cards[0]?.question === 'Recovered');
    await change(() => rm(file), state => state.files.length === 0 && state.errors.length === 0);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
test('missing materials path fails explicitly', async () => {
  await assert.rejects(createDeckStore('/nonexistent-flashcards-directory'), /ENOENT/);
});

test('linked materials root watches linked file and subfolder targets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flashcards-watch-links-'));
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
  async function update(filename: string, question: string) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Linked target update timed out')); }, 6000);
      const unsubscribe = store.subscribe(state => {
        if (state.cards.some(card => card.question === question)) {
          clearTimeout(timeout); unsubscribe(); resolve();
        }
      });
      writeFile(filename, valid(question)).catch(error => { clearTimeout(timeout); unsubscribe(); reject(error); });
    });
  }
  try {
    assert.deepEqual(store.getState().files, ['folder/nested.md', 'linked.md']);
    await update(linkedFile, 'Updated file');
    await update(nestedFile, 'Updated nested');
    await update(path.join(external, 'new.md'), 'Added nested');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
