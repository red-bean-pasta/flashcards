import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPathSpec } from '../src/lib/path-spec.ts';

test('formats folder paths with trailing slash indicating directories', () => {
  assert.equal(formatPathSpec('', 'flashcards'), 'flashcards/');
  assert.equal(formatPathSpec('Writing Task 1/', 'flashcards'), 'flashcards/Writing Task 1/');
  assert.equal(formatPathSpec('Writing Task 1/Drafts/', 'flashcards'), 'flashcards/Writing Task 1/Drafts/');
});

test('handles empty root name without leading slash', () => {
  assert.equal(formatPathSpec('', ''), './');
  assert.equal(formatPathSpec('Writing Task 1/', ''), 'Writing Task 1/');
  assert.equal(formatPathSpec('Writing Task 1/Drafts/', ''), 'Writing Task 1/Drafts/');
});
