import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryDecision } from '../src/lib/mutation-retry.ts';
import { DeckRequestError } from '../src/lib/deck-client.ts';
import { GraphError } from '../src/lib/onedrive/graph.ts';

test('temporary failures back off and retain Retry-After through wrapped causes', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  const throttled = new DeckRequestError('Rate limited', { cause: new GraphError('throttled', { status: 429, code: 'throttled', retryAfter: '30' }) });
  assert.deepEqual(retryDecision(throttled, 0, now, 0), { kind: 'retry', notBefore: now + 30_000 });
  const offline = new GraphError('offline', { status: 0, code: 'networkError' });
  assert.deepEqual([0, 1, 2, 3, 4].map(n => retryDecision(offline, n, now, 0)), [2000, 4000, 8000, 120_000, 120_000].map(delay => ({ kind: 'retry', notBefore: now + delay })));
  const dated = new GraphError('busy', { status: 503, code: 'busy', retryAfter: 'Fri, 30 Oct 2026 00:01:00 GMT' }, true);
  assert.deepEqual(retryDecision(dated, 0, now, 1), { kind: 'retry', notBefore: now + 60_000 });
});

test('invalid Retry-After and failures requiring action do not receive a countdown', () => {
  const now = Date.now();
  for (const error of [new GraphError('expired', { status: 401, code: 'auth' }), new GraphError('bad deadline', { status: 429, code: 'throttled', retryAfter: 'later' }), new Error('bug')]) {
    assert.deepEqual(retryDecision(error, 0, now, 0), { kind: 'review' });
  }
});

test('temporary local filesystem network failures are eligible for review and retry', () => {
  const failure = new DeckRequestError('Network unavailable', { cause: new DOMException('Network unavailable', 'NetworkError') });
  assert.deepEqual(retryDecision(failure, 0, 1000, 0), { kind: 'retry', notBefore: 3000 });
  assert.deepEqual(retryDecision(new DOMException('Access denied', 'NotAllowedError'), 0, 1000, 0), { kind: 'review' });
});

test('an aggregate containing an internal defect is never retried as a network error', () => {
  const failure = new AggregateError([new GraphError('offline', { status: 0, code: 'networkError' }, true), new Error('inspection invariant violated')], 'Both failed');
  assert.deepEqual(retryDecision(failure, 0, 1000, 0), { kind: 'review' });
  const wrapped = new AggregateError([new GraphError('offline', { status: 0, code: 'networkError' }), new DeckRequestError('inspection failed', { cause: new Error('invariant') })]);
  assert.deepEqual(retryDecision(wrapped, 0, 1000, 0), { kind: 'review' });
});

test('an aggregate of external network failures remains retryable', () => {
  const failure = new AggregateError([new GraphError('offline', { status: 0, code: 'networkError' }, true, { cause: new TypeError('network') }), new GraphError('offline', { status: 503, code: 'busy' })], 'Both failed');
  assert.deepEqual(retryDecision(failure, 0, 1000, 0), { kind: 'retry', notBefore: 3000 });
});
