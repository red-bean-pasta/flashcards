import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSource, sourceLabel } from '../src/lib/source-names.ts';

test('exact display labels match existing files regardless of case and surrounding spaces', () => {
  assert.deepEqual(resolveSource(['Speaking_Rephrases.MD'], '  speaking rephrases  ', ''), {
    source: 'Speaking_Rephrases.MD', create: false, error: '',
  });
  assert.equal(sourceLabel('speaking/part_two.MD'), 'Speaking / Part Two');
});

test('colliding display labels require a choice and preserve the chosen filename', () => {
  const files = ['part_one.md', 'part-one.md'];
  assert.match(resolveSource(files, 'Part One', '').error, /Choose the intended file/);
  assert.deepEqual(resolveSource(files, 'Part One', 'part-one.md'), {
    source: 'part-one.md', create: false, error: '',
  });
});

test('new filenames preserve Unicode normalization and default-file selection', () => {
  assert.deepEqual(resolveSource([], '  ＩＥＬＴＳ — 中文.MD  ', ''), {
    source: 'ielts_中文.md', create: true, error: '',
  });
  assert.deepEqual(resolveSource([], 'Default', 'default.md'), {
    source: 'default.md', create: false, error: '',
  });
  assert.deepEqual(resolveSource([], 'Default', ''), {
    source: 'default.md', create: true, error: '',
  });
});

test('invalid names and the archive remain explicit submission errors', () => {
  for (const input of ['', '  ', '---', '.md', ' .MD ']) {
    assert.deepEqual(resolveSource([], input, ''), { source: '', create: false, error: 'Enter a file name.' });
  }
  const archive = resolveSource([], 'Removed.md', '');
  assert.equal(archive.source, 'removed.md');
  assert.equal(archive.create, true);
  assert.match(archive.error, /reserved/);
  assert.match(resolveSource(['REMOVED.MD'], 'Removed', 'REMOVED.MD').error, /reserved/);
});
