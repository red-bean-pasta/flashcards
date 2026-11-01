import { mapConcurrent } from './concurrent-map.js';

export class BatchResponseError extends Error {}
type Reply = { id: string; status: number; body: unknown; headers?: Record<string, string> };

/** Validate correlation before exposing any successful-looking batch results. */
export function parseBatchReplies(value: unknown, ids: readonly string[]): Reply[] {
  const responses = (value as { responses?: unknown } | null)?.responses;
  if (!Array.isArray(responses) || responses.length !== ids.length) throw new BatchResponseError('Batch response count mismatch.');
  const replies = new Map<string, Reply>();
  for (const reply of responses) {
    if (!reply || typeof reply.id !== 'string' || !ids.includes(reply.id) || replies.has(reply.id) ||
        !Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 ||
        (reply.headers !== undefined && (!reply.headers || typeof reply.headers !== 'object' || Array.isArray(reply.headers) || !Object.values(reply.headers).every(value => typeof value === 'string')))) {
      throw new BatchResponseError('Invalid batch response.');
    }
    replies.set(reply.id, reply);
  }
  return ids.map(id => {
    const reply = replies.get(id);
    if (!reply) throw new BatchResponseError('Missing batch response.');
    return reply;
  });
}

/** Five subrequests per HTTP call; at most ten HTTP calls in flight. */
export async function readMetadataBatches<T>(ids: readonly string[], read: (group: string[], signal: AbortSignal) => Promise<T[]>, signal?: AbortSignal): Promise<T[]> {
  const groups: string[][] = [];
  for (let index = 0; index < ids.length; index += 5) groups.push(ids.slice(index, index + 5));
  return (await mapConcurrent(groups, async (group, activeSignal) => {
    const result = await read(group, activeSignal);
    if (result.length !== group.length) throw new Error('Metadata reader returned an unexpected item count.');
    return result;
  }, signal, 10)).flat();
}
