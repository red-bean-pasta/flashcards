import { archiveFilename } from '../card-text.js';
import { DeckRequestError } from '../deck-client.js';
import { createLoadBudget } from '../load-budget.js';
import type { GraphClient, GraphItem } from './graph.js';
import { mapConcurrent } from './concurrent-map.js';

type FolderScan = { id: string; prefix: string; ancestors: Set<string> };

/** List sibling folders together, then assemble the original depth-first source order. */
export async function scanOneDriveFolder(graph: GraphClient, root: GraphItem, budget: ReturnType<typeof createLoadBudget>, signal?: AbortSignal) {
  const listings = new Map<string, GraphItem[]>();
  let pending: FolderScan[] = [{ id: root.id, prefix: '', ancestors: new Set() }];
  while (pending.length) {
    const wave = await mapConcurrent(pending, async (folder, activeSignal) => {
      if (folder.ancestors.has(folder.id)) throw new DeckRequestError('OneDrive returned a recursive folder.');
      const children = await graph.children(folder.id, activeSignal, budget.remainingEntries());
      activeSignal.throwIfAborted();
      const visible = children.filter(item => !item.name.startsWith('.') && item.name.toLowerCase() !== archiveFilename);
      for (const item of visible) budget.entry(folder.prefix + item.name);
      return { folder, children, visible };
    }, signal);
    pending = [];
    for (const { folder, children, visible } of wave) {
      if (listings.has(folder.id)) throw new DeckRequestError('OneDrive returned a duplicate folder.');
      listings.set(folder.id, children);
      for (const item of visible) {
        if (item.folder) pending.push({ id: item.id, prefix: folder.prefix + item.name + '/', ancestors: new Set([...folder.ancestors, folder.id]) });
      }
    }
  }

  const sources = new Map<string, GraphItem>();
  function collect(id: string, prefix: string): void {
    const children = listings.get(id);
    if (!children) throw new Error('Scanned folder listing is missing.');
    for (const item of children) {
      if (item.name.startsWith('.') || item.name.toLowerCase() === archiveFilename) continue;
      const source = prefix + item.name;
      if (item.folder) collect(item.id, source + '/');
      else if (item.file && /\.md$/i.test(item.name)) {
        if (sources.has(source)) throw new DeckRequestError('OneDrive returned a duplicate file path.');
        sources.set(source, item);
      }
    }
  }
  collect(root.id, '');
  const archive = findArchive(listings, root.id);
  return { sources, archive };
}

function findArchive(listings: Map<string, GraphItem[]>, rootId: string): GraphItem | undefined {
  const children = listings.get(rootId);
  if (!children) throw new Error('Scanned root listing is missing.');
  const archives = children.filter(item => item.name.toLowerCase() === archiveFilename);
  if (archives.length > 1) throw new DeckRequestError('OneDrive returned duplicate removed.md entries.');
  const archive = archives[0];
  if (archive && !archive.file) throw new DeckRequestError('removed.md is not a file.');
  return archive;
}
