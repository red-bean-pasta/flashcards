import { createLoadBudget } from '../load-budget.js';
import type { GraphClient, GraphItem } from './graph.js';
import type { FileSnapshot, SnapshotCache } from './snapshot-cache.js';
import { mapConcurrent } from './concurrent-map.js';

export const FILE_READ_CONCURRENCY = 10;
type Entry = { source: string; item: GraphItem; snapshot?: FileSnapshot; text?: string; hit: boolean };
type Budget = ReturnType<typeof createLoadBudget>;

async function inspectCache(cache: SnapshotCache, [source, item]: [string, GraphItem], signal: AbortSignal): Promise<Entry> {
  const cached = await cache.get(source);
  signal.throwIfAborted();
  const hit = cached != null && cached.id === item.id && item.eTag !== undefined && cached.revision === item.eTag;
  return { source, item, snapshot: hit ? cached : undefined, hit };
}

async function downloadEntry(graph: GraphClient, entry: Entry, budget: Budget, signal: AbortSignal): Promise<void> {
  if (!entry.item.downloadUrl || !entry.item.eTag) entry.item = await graph.getItem(entry.item.id, signal);
  entry.text = await graph.download(entry.item, signal, budget.remainingBytes(), budget.transfer);
}

async function acceptSnapshot(graph: GraphClient, cache: SnapshotCache, entry: Entry, after: GraphItem, budget: Budget, signal: AbortSignal) {
  if (entry.text === undefined) throw new Error('Verification requires downloaded text.');
  if (after.id !== entry.item.id || !after.eTag) throw new Error('Revision check does not match the downloaded file.');
  const snapshot = entry.item.eTag === after.eTag
    ? { id: entry.item.id, text: entry.text, revision: after.eTag }
    : await graph.readText(entry.item.id, signal, budget.remainingBytes(), { metadata: after, onBytes: budget.transfer });
  signal.throwIfAborted();
  budget.file(entry.source, new TextEncoder().encode(snapshot.text).byteLength);
  await cache.put(entry.source, snapshot);
  entry.snapshot = snapshot;
}

function accountCachedSnapshots(entries: Entry[], budget: Budget): void {
  for (const entry of entries) {
    if (!entry.hit) continue;
    if (!entry.snapshot) throw new Error('Cache hit requires a snapshot.');
    const bytes = new TextEncoder().encode(entry.snapshot.text).byteLength;
    budget.transfer(bytes);
    budget.file(entry.source, bytes);
  }
}

/** Cache inspection -> bounded downloads -> five-item revision batches -> acceptance. */
export async function readOneDriveFiles(graph: GraphClient, cache: SnapshotCache, entries: [string, GraphItem][], budget: Budget, signal?: AbortSignal) {
  const prepared = await mapConcurrent(entries, (entry, activeSignal) => inspectCache(cache, entry, activeSignal), signal, FILE_READ_CONCURRENCY);
  accountCachedSnapshots(prepared, budget);
  const missing = prepared.filter(entry => !entry.hit);
  await mapConcurrent(missing, (entry, activeSignal) => downloadEntry(graph, entry, budget, activeSignal), signal, FILE_READ_CONCURRENCY);
  const verified = await graph.getItems(missing.map(entry => entry.item.id), signal);
  if (verified.length !== missing.length) throw new Error('Revision check returned an unexpected item count.');
  await mapConcurrent(missing.map((entry, index) => ({ entry, after: verified[index] })), ({ entry, after }, activeSignal) => acceptSnapshot(graph, cache, entry, after, budget, activeSignal), signal, FILE_READ_CONCURRENCY);
  signal?.throwIfAborted();
  return prepared.map(entry => {
    if (!entry.snapshot) throw new Error('Accepted file snapshot is missing.');
    return { source: entry.source, snapshot: entry.snapshot, hit: entry.hit };
  });
}
