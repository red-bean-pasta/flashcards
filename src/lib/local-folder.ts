import { createLoadBudget } from './load-budget.js';
import { archiveFilename, isNewSourceName, appendArchivedEntries } from './card-text.js';
import { CardParseError } from './card-ranges.js';
import { CardInputError } from './card-text.js';
import { parseBrowserCards } from './browser-cards.js';
import { DeckRequestError, RetryableLocalConflict } from './deck-client.js';
import { captureOperation, createOperationProjector, isUnchangedEdit, planContent, validateTargets } from './onedrive/operations.js';
import type { DeckBackend } from './deck-backend.js';
import type { DeckState, MutationRequest } from './types.js';
import type { StoredMutation, MutationWritePlan } from './mutation-storage.js';
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

  async function write(handle: FileSystemFileHandle, before: string | null, text: string): Promise<void> {
    // Browsers that implement mode coordinate exclusive writers. Older browsers may
    // ignore the option; it does not lock external programs in either case.
    const stream = await handle.createWritable({ mode: 'exclusive' } as FileSystemCreateWritableOptions);
    let closing = false;
    try {
      const current = await (await handle.getFile()).text();
      if (current !== (before ?? '')) throw new RetryableLocalConflict('The file changed before saving; the change will be retried.');
      await stream.write(text);
      closing = true;
      await stream.close();
    } catch (error) {
      if (!closing) {
        try { await stream.abort(); } catch (abortError) {
          throw new AggregateError([error, abortError], 'The local write failed and its stream could not be aborted. Review the pending change.');
        }
      }
      throw error;
    }
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
    if (!change.removed) return { source, archive: { id: null, name: archiveFilename, before: null, after: '', revision: null } };
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
    if (current !== plan.before) throw new RetryableLocalConflict('The file changed before saving; the change will be retried.');
    const handle = plan.name === archiveFilename ? await root.getFileHandle(plan.name, { create: true }) : sources.get(plan.name);
    if (!handle) throw new DeckRequestError('The source file is no longer available. Review the pending change.');
    await write(handle, plan.before, plan.after);
  }

  async function execute(item: StoredMutation, checkpoint: (item: StoredMutation) => Promise<void>, _recovered = false): Promise<DeckState> {
    if (saving) throw new Error('Concurrent local folder save.');
    saving = true;
    async function advance(patch: Partial<StoredMutation>) { Object.assign(item, patch); await checkpoint(item); }
    try {
      if (isUnchangedEdit(item.operation)) return item.snapshot;
      validateMutationPlan(item);
      if (item.sourceWrite && item.stage === 'queued') throw new Error('Unexpected pending local mutation stage.');
      if (item.sourceWrite && item.stage === 'source-writing' && await localCurrent(item.sourceWrite) === item.sourceWrite.after) {
        await advance({ stage: 'releasing' });
      }
      if (item.stage !== 'releasing') {
        for (let attempt = 0; attempt < 3; attempt++) {
          await advance({ stage: 'preparing', sourceWrite: undefined, archiveWrite: undefined });
          const plan = await localPlan(item);
          await advance({ sourceWrite: plan.source, archiveWrite: plan.archive, stage: plan.archive ? 'archive-ready' : 'source-ready' });
          validateMutationPlan(item);
          try {
            if (plan.source.before !== plan.source.after) {
              if (plan.archive && (plan.archive.before ?? '') !== plan.archive.after) {
                await advance({ stage: 'archive-writing' });
                await localPublish(plan.archive);
              }
              await advance({ stage: 'source-writing' });
              await localPublish(plan.source);
            }
            await advance({ stage: 'releasing' });
            break;
          } catch (error) {
            if (!(error instanceof RetryableLocalConflict) || attempt === 2) throw error;
          }
        }
      }
      if (item.stage !== 'releasing') throw new Error('Unexpected pending local mutation stage.');
      const source = item.sourceWrite!;
      const handle = sources.get(source.name);
      if (!handle) throw new DeckRequestError('The saved file is no longer available. Refresh to review it.');
      const file = await handle.getFile();
      const applied = item.operation.action === 'add' || planContent(source.before ?? '', item.operation).matched > 0;
      return project(item.snapshot, item.operation, `${file.lastModified}:${file.size}`, await file.text(), applied);
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
