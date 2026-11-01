import { archiveFilename } from '../card-text.js';
import { CardParseError } from '../card-ranges.js';
import { createLoadBudget } from '../load-budget.js';
import type { parseBrowserCards } from '../browser-cards.js';
import type { DeckState } from '../types.js';
import type { GraphClient, GraphItem } from './graph.js';
import type { SnapshotCache, FileSnapshot } from './snapshot-cache.js';
import { mapConcurrent } from './concurrent-map.js';
import { scanOneDriveFolder } from './scan.js';

/** Cache hits require fresh remote identity/revision evidence from this load's listing. */
async function readSnapshot(graph: GraphClient, cache: SnapshotCache, source: string, item: GraphItem, budget: ReturnType<typeof createLoadBudget>, signal: AbortSignal) {
  const cached = await cache.get(source);
  signal.throwIfAborted();
  const hit = cached != null && cached.id === item.id && item.eTag !== undefined && cached.revision === item.eTag;
  const snapshot = hit ? cached : await graph.readText(item.id, signal, budget.remainingBytes(), {
    metadata: item, onBytes: budget.transfer,
  });
  signal.throwIfAborted();
  const bytes = new TextEncoder().encode(snapshot.text).byteLength;
  if (hit) budget.transfer(bytes);
  budget.file(source, bytes);
  if (!hit) await cache.put(source, snapshot);
  signal.throwIfAborted();
  return { source, snapshot, hit };
}

function parseSnapshots(snapshots: Array<{ source: string; snapshot: FileSnapshot }>, parse: typeof parseBrowserCards, files: string[]): DeckState {
  const cards: DeckState['cards'] = [];
  const errors: string[] = [];
  const revisions: Record<string, string> = {};
  for (const { source, snapshot } of snapshots) {
    if (source === archiveFilename) continue;
    try {
      cards.push(...parse(snapshot.text, source));
      revisions[source] = snapshot.revision;
    } catch (error) {
      if (!(error instanceof CardParseError)) throw error;
      errors.push(error.message);
    }
  }
  return { cards: errors.length ? [] : cards, files: files.sort(), revisions, errors };
}

export async function loadOneDriveDeck(graph: GraphClient, folder: GraphItem, cache: SnapshotCache, parse: typeof parseBrowserCards, signal?: AbortSignal) {
  const start = performance.now();
  const budget = createLoadBudget();
  const scan = await scanOneDriveFolder(graph, folder, budget, signal);
  const scanned = performance.now();
  const entries = [...scan.sources.entries()];
  if (scan.archive) entries.push([archiveFilename, scan.archive]);
  const snapshots = await mapConcurrent(entries, ([source, item], activeSignal) => readSnapshot(graph, cache, source, item, budget, activeSignal), signal);
  if (!scan.archive) await cache.put(archiveFilename, null);
  signal?.throwIfAborted();
  const read = performance.now();
  const deck = parseSnapshots(snapshots, parse, [...scan.sources.keys()]);
  console.info('OneDrive load ' + JSON.stringify({
    durationMs: Math.round(performance.now() - start), scanMs: Math.round(scanned - start),
    readMs: Math.round(read - scanned), parseMs: Math.round(performance.now() - read),
    files: scan.sources.size, folders: scan.folders,
    downloadedFiles: snapshots.filter(item => !item.hit).length, cachedFiles: snapshots.filter(item => item.hit).length,
  }));
  return { deck, sources: scan.sources };
}
