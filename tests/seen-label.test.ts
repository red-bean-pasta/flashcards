import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSeenLabel } from '../src/lib/seen-label.ts';

test('formatSeenLabel formats zero, singular, and plural encounter counts', () => {
  assert.equal(formatSeenLabel(0), 'Seen 0 times');
  assert.equal(formatSeenLabel(1), 'Seen 1 time');
  assert.equal(formatSeenLabel(2), 'Seen 2 times');
  assert.equal(formatSeenLabel(12), 'Seen 12 times');
});

test('formatSeenLabel rejects negative and non-integer counts', () => {
  assert.throws(() => formatSeenLabel(-1), RangeError);
  assert.throws(() => formatSeenLabel(1.5), RangeError);
  assert.throws(() => formatSeenLabel(Number.NaN), RangeError);
});
