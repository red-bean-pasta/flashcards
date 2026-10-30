import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoadBudget } from '../src/lib/load-budget.ts';

test('load budget rejects excessive depth, entries, file size and total size', () => {
  assert.throws(() => createLoadBudget().entry(Array(33).fill('x').join('/')), /depth/);
  const entries = createLoadBudget();
  for (let i = 0; i < 2000; i++) entries.entry('x');
  assert.throws(() => entries.entry('x'), /2,000|2000/);
  assert.throws(() => createLoadBudget().file('large.md', 5 * 1024 * 1024 + 1), /large.md/);
  const total = createLoadBudget();
  for (let i = 0; i < 10; i++) total.file('file.md', 5 * 1024 * 1024);
  assert.throws(() => total.file('extra.md', 1), /total limit/);
});
