import { GraphError } from './onedrive/graph.js';
import { OneDriveAuthError } from './onedrive/auth.js';
import { DeckRequestError } from './deck-client.js';

export type RetryDecision =
  | { kind: 'retry'; notBefore: number }
  | { kind: 'review' };

/** Walk wrapped errors without losing transport metadata. */
function causes(error: unknown): unknown[] {
  const pending = [error];
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    found.push(current);
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
  }
  return found;
}

function aggregateHasDefect(error: AggregateError): boolean {
  function defect(item: unknown): boolean {
    if (item instanceof AggregateError) return item.errors.some(defect);
    if (item instanceof GraphError || item instanceof OneDriveAuthError || item instanceof DOMException) return false;
    if (item instanceof DeckRequestError) return item.cause !== undefined && defect(item.cause);
    return true;
  }
  return error.errors.some(defect);
}

/** Invalid service deadlines cannot safely be treated as immediate retry permission. */
function retryAfterDeadline(value: string | null, now: number): number | null {
  if (value === null) return now;
  if (/^\d+$/.test(value.trim())) {
    const deadline = now + Number(value.trim()) * 1000;
    return Number.isSafeInteger(deadline) ? deadline : null;
  }
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(now, deadline) : null;
}

export function requiresReconnect(error: unknown): boolean {
  return causes(error).some(item => (item instanceof OneDriveAuthError && item.reconnectRequired) ||
    (item instanceof GraphError && [401, 403].includes(item.status)) ||
    (item instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(item.name)));
}

export function serviceRetryDeadline(error: unknown, now: number): number | null {
  let result = now;
  for (const item of causes(error)) if (item instanceof GraphError) {
    const deadline = retryAfterDeadline(item.retryAfter, now);
    if (deadline === null) return null;
    result = Math.max(result, deadline);
  }
  return result;
}

/** Classifies transport failures only; callers must separately establish replay safety. */
export function retryDecision(error: unknown, attempts: number, now: number, jitter: number): RetryDecision {
  if (!Number.isInteger(attempts) || attempts < 0 || !Number.isFinite(now) || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new Error('Invalid retry scheduler input.');
  const chain = causes(error);
  // An aggregate can contain an independent defect alongside a transport error.
  if (chain.some(item => item instanceof AggregateError && aggregateHasDefect(item))) return { kind: 'review' };
  const temporaryLocal = chain.some(item => item instanceof DOMException && ['NetworkError', 'TimeoutError'].includes(item.name));
  if (chain.some(item => item instanceof OneDriveAuthError && item.code !== 'network')) return { kind: 'review' };
  const graphErrors = chain.filter((item): item is GraphError => item instanceof GraphError);
  if (graphErrors.some(item => ![0, 429, 500, 502, 503, 504].includes(item.status))) return { kind: 'review' };
  if (graphErrors.some(item => item.status === 0 && item.code !== 'networkError')) return { kind: 'review' };
  if (!graphErrors.length && !temporaryLocal && !chain.some(item => item instanceof OneDriveAuthError && item.code === 'network')) return { kind: 'review' };
  const serviceDeadline = serviceRetryDeadline(error, now);
  if (serviceDeadline === null) return { kind: 'review' };
  const delay = attempts < 3 ? [2000, 4000, 8000][attempts] * (1 + jitter * 0.25) : 120_000;
  return { kind: 'retry', notBefore: Math.max(serviceDeadline, now + delay) };
}
