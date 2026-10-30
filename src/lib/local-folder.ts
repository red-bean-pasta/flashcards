import { createLoadBudget } from './load-budget.js';
import { archiveFilename, isNewSourceName, appendArchivedEntries } from './card-text.js';
import { CardParseError } from './card-ranges.js';
import { CardInputError } from './card-text.js';
import { parseBrowserCards } from './browser-cards.js';
import { DeckRequestError } from './deck-client.js';
import { captureOperation, createOperationProjector, isUnchangedEdit, planContent, validateTargets } from './onedrive/operations.js';
import type { DeckBackend } from './deck-backend.js';
import type { DeckState, MutationRequest } from './types.js';
import type { StoredMutation, MutationWritePlan } from './mutation-storage.js';
import { reviewArchive, reviewSource } from './mutation-review.js';
import { validateMutationPlan } from './mutation-plan.js';

export type Directory = FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };

function report(error: unknown): never {
  if (error instanceof DOMException || error instanceof CardParseError || error instanceof CardInputError) {
    throw new DeckRequestError(error.message, { cause: error });
  }
  throw error;
}

export type AccessibleDirectory = Directory & { queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>; requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState> };

export function createLocalFolderBackend(root: Directory, parse = parseBrowserCards): DeckBackend {
  const sources = new Map<string, FileSystemFileHandle>();
  const project = createOperationProjector(parse);
  let saving = false;

  async function scan(directory: Directory, found: Map<string, FileSystemFileHandle>, signal?: AbortSignal, prefix = '', budget = createLoadBudget()): Promise<void> {
    for await (const entry of directory.values()) {
      signal?.throwIfAborted();
      if (entry.name.startsWith('.') || entry.name.toLowerCase() === archiveFilename) continue;
      const path = prefix + entry.name;
      budget.entry(path);
      if (entry.kind === 'directory') await scan(entry as Directory, found, signal, path + '/', budget);
      else if (/\.md$/i.test(entry.name)) found.set(path, entry as FileSystemFileHandle);
    }
  }

  async function load(signal?: AbortSignal): Promise<DeckState> {
    try {
      const found = new Map<string, FileSystemFileHandle>();
      const budget = createLoadBudget();
      await scan(root, found, signal, '', budget);
      const cards: DeckState['cards'] = [];
      const revisions: Record<string, string> = {};
      const errors: string[] = [];
      for (const [source, handle] of found) {
        signal?.throwIfAborted();
        const file = await handle.getFile();
        budget.file(source, file.size);
        try { cards.push(...parse(await file.text(), source)); }
        catch (error) { if (!(error instanceof CardParseError)) throw error; errors.push(error.message); }
        revisions[source] = `${file.lastModified}:${file.size}`;
      }
      signal?.throwIfAborted();
      sources.clear();
      for (const [path, handle] of found) sources.set(path, handle);
      return { cards: errors.length ? [] : cards, files: [...found.keys()].sort(), revisions, errors };
    } catch (error) { report(error); }
  }

  async function write(handle: FileSystemFileHandle, text: string): Promise<void> {
    const stream = await handle.createWritable();
    await stream.write(text);
    await stream.close();
  }

  async function mutate(request: MutationRequest, deck: DeckState): Promise<DeckState> {
    const operation = captureOperation(deck, request);
    const item: StoredMutation = { id: crypto.randomUUID(), createdAt: Date.now(), destination: { provider: 'local', folder: root }, request, operation, snapshot: deck, stage: 'queued', attempts: 0 };
    return execute(item, async () => {});
  }

  async function localPlan(item: StoredMutation): Promise<{ source: MutationWritePlan; archive?: MutationWritePlan }> {
    const operation = item.operation;
    let handle = sources.get(operation.source);
    if (!handle) {
      if (!isNewSourceName(operation.source)) throw new DeckRequestError('The card file is no longer available. Refresh to review your notes.');
      try { handle = await root.getFileHandle(operation.source, { create: operation.action === 'add' }); }
      catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') throw new DeckRequestError('The card file is no longer available. Refresh to review your notes.', { cause: error });
        throw error;
      }
      sources.set(operation.source, handle);
    }
    const before = await (await handle.getFile()).text();
    validateTargets(before, operation, item.snapshot);
    const change = planContent(before, operation);
    const source: MutationWritePlan = { id: operation.source, name: operation.source, before, after: change.text, revision: null };
    if (operation.action !== 'remove') return { source };
    let old: string | null = null;
    try { old = await (await (await root.getFileHandle(archiveFilename)).getFile()).text(); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
    if (old !== null) parse(old, archiveFilename);
    return { source, archive: { id: old === null ? null : archiveFilename, name: archiveFilename, before: old, after: appendArchivedEntries(old ?? '', change.removed), revision: null } };
  }

  async function localCurrent(plan: MutationWritePlan): Promise<string | null> {
    let handle = plan.name === archiveFilename ? undefined : sources.get(plan.name);
    if (!handle && plan.name !== archiveFilename) return null;
    if (!handle) {
      try { handle = await root.getFileHandle(plan.name); }
      catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return null; throw error; }
    }
    return (await handle.getFile()).text();
  }

  async function localPublish(plan: MutationWritePlan): Promise<void> {
    const current = await localCurrent(plan);
    if (current !== plan.before) throw new DeckRequestError('The file changed before saving. Review the pending change.');
    const handle = plan.name === archiveFilename ? await root.getFileHandle(plan.name, { create: true }) : sources.get(plan.name);
    if (!handle) throw new DeckRequestError('The source file is no longer available. Review the pending change.');
    await write(handle, plan.after);
  }

  async function execute(item: StoredMutation, checkpoint: (item: StoredMutation) => Promise<void>, recovered = false): Promise<DeckState> {
    if (saving) throw new Error('Concurrent local folder save.');
    saving = true;
    async function advance(patch: Partial<StoredMutation>) { Object.assign(item, patch); await checkpoint(item); }
    try {
      if (isUnchangedEdit(item.operation)) return item.snapshot;
      if (!item.sourceWrite) {
        await advance({ stage: 'preparing' });
        const plan = await localPlan(item);
        await advance({ sourceWrite: plan.source, archiveWrite: plan.archive, stage: plan.archive ? 'archive-ready' : 'source-ready' });
      }
      validateMutationPlan(item);
      const source = item.sourceWrite!;
      if (item.stage === 'archive-writing') {
        const archive = item.archiveWrite!;
        const result = reviewArchive(item.operation, archive.before ?? '', archive.after, (await localCurrent(archive)) ?? '');
        if (result === 'needs-review') throw new DeckRequestError('The archive changed while saving. Review the pending removal.');
        if (result === 'safe-to-retry' && recovered) throw new DeckRequestError('The previous local archive write may still be finishing. Review the pending removal.');
        await advance({ stage: result === 'satisfied' ? 'source-ready' : 'archive-ready' });
      }
      if (item.stage === 'archive-ready') {
        await advance({ stage: 'archive-writing' });
        await localPublish(item.archiveWrite!);
        await advance({ stage: 'source-ready' });
      }
      if (item.stage === 'source-writing') {
        const current = await localCurrent(source);
        const archive = item.operation.action === 'remove' ? await localCurrent(item.archiveWrite!) : undefined;
        const result = reviewSource(item.operation, source.before ?? '', current ?? '', archive ?? '');
        if (result === 'needs-review') throw new DeckRequestError('The save outcome is unclear. Review the current file before continuing.');
        if (result === 'safe-to-retry' && recovered) throw new DeckRequestError('The previous local write may still be finishing. Review the pending change.');
        await advance({ stage: result === 'satisfied' ? 'releasing' : 'source-ready' });
      }
      if (item.stage === 'source-ready' && item.operation.action === 'remove') {
        const current = await localCurrent(source);
        const archive = await localCurrent(item.archiveWrite!);
        if (current !== null && reviewSource(item.operation, source.before ?? '', current, archive ?? '') === 'satisfied') {
          await advance({ stage: 'releasing' });
        }
      }
      if (item.stage === 'source-ready') {
        await advance({ stage: 'source-writing' });
        await localPublish(source);
        await advance({ stage: 'releasing' });
      }
      if (item.stage !== 'releasing') throw new Error('Unexpected pending local mutation stage.');
      const handle = sources.get(source.name);
      if (!handle) throw new DeckRequestError('The saved file is no longer available. Refresh to review it.');
      const file = await handle.getFile();
      return project(item.snapshot, item.operation, `${file.lastModified}:${file.size}`, await file.text());
    } catch (error) { report(error); }
    finally { saving = false; }
  }
  return { load, mutate, persistent: { destination: { provider: 'local' as const, folder: root }, execute } };
}

export async function pickLocalFolder(): Promise<{ backend: DeckBackend; name: string; handle: Directory }> {
  const picker = (window as Window & { showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<Directory> }).showDirectoryPicker;
  if (!picker) throw new DeckRequestError('Direct folder access requires a supported Chromium browser. Firefox and Safari cannot save changes to a selected folder.');
  try {
    const folder = await picker.call(window, { mode: 'readwrite' });
    return { backend: createLocalFolderBackend(folder), name: folder.name, handle: folder };
  }
  catch (error) { report(error); }
}
