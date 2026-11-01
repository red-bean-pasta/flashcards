import { archiveFilename } from '../card-text.js';
import { CardParseError } from '../card-ranges.js';
import { createLoadBudget } from '../load-budget.js';
import type { parseBrowserCards } from '../browser-cards.js';
import type { DeckState } from '../types.js';
import type { GraphClient, GraphItem } from './graph.js';
import type { SnapshotCache, FileSnapshot } from './snapshot-cache.js';
import { readOneDriveFiles, FILE_READ_CONCURRENCY } from './read-files.js';
import { scanOneDriveFolder } from './scan.js';

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
  const snapshots = await readOneDriveFiles(graph, cache, entries, budget, signal);
  if (!scan.archive) await cache.put(archiveFilename, null);
  signal?.throwIfAborted();
  const read = performance.now();
  const deck = parseSnapshots(snapshots, parse, [...scan.sources.keys()]);
  console.info('OneDrive load ' + JSON.stringify({
    readConcurrency: FILE_READ_CONCURRENCY,
    durationMs: Math.round(performance.now() - start), scanMs: Math.round(scanned - start),
    readMs: Math.round(read - scanned), parseMs: Math.round(performance.now() - read),
    files: scan.sources.size, folders: scan.folders,
    downloadedFiles: snapshots.filter(item => !item.hit).length, cachedFiles: snapshots.filter(item => item.hit).length,
  }));
  return { deck, sources: scan.sources };
}
