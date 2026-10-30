import { archiveFilename, isNewSourceName, appendArchivedEntries } from './card-text.js';
import { CardParseError } from './card-ranges.js';
import { CardInputError } from './card-text.js';
import { parseBrowserCards } from './browser-cards.js';
import { DeckRequestError } from './deck-client.js';
import { captureOperation, createOperationProjector, planContent } from './onedrive/operations.js';
import type { DeckBackend } from './deck-backend.js';
import type { DeckState, MutationRequest } from './types.js';

type Directory = FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };

function report(error: unknown): never {
  if (error instanceof DOMException || error instanceof CardParseError || error instanceof CardInputError) {
    throw new DeckRequestError(error.message, { cause: error });
  }
  throw error;
}

export function createLocalFolderBackend(root: Directory, parse = parseBrowserCards): DeckBackend {
  const sources = new Map<string, FileSystemFileHandle>();
  const project = createOperationProjector(parse);
  let saving = false;

  async function scan(directory: Directory, found: Map<string, FileSystemFileHandle>, signal?: AbortSignal, prefix = ''): Promise<void> {
    for await (const entry of directory.values()) {
      signal?.throwIfAborted();
      if (entry.name.startsWith('.') || entry.name.toLowerCase() === archiveFilename) continue;
      const path = prefix + entry.name;
      if (entry.kind === 'directory') await scan(entry as Directory, found, signal, path + '/');
      else if (/\.md$/i.test(entry.name)) found.set(path, entry as FileSystemFileHandle);
    }
  }

  async function load(signal?: AbortSignal): Promise<DeckState> {
    try {
      const found = new Map<string, FileSystemFileHandle>();
      await scan(root, found, signal);
      const cards: DeckState['cards'] = [];
      const revisions: Record<string, string> = {};
      const errors: string[] = [];
      for (const [source, handle] of found) {
        signal?.throwIfAborted();
        const file = await handle.getFile();
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

  async function archiveRemoval(removed: string): Promise<void> {
    const archive = await root.getFileHandle(archiveFilename, { create: true });
    const old = await (await archive.getFile()).text();
    parse(old, archiveFilename);
    await write(archive, appendArchivedEntries(old, removed));
  }

  async function mutate(request: MutationRequest, deck: DeckState): Promise<DeckState> {
    if (saving) throw new Error('Concurrent local folder save.');
    saving = true;
    try {
      const operation = captureOperation(deck, request);
      let handle = sources.get(operation.source);
      if (!handle) {
        if (operation.action !== 'add') throw new DeckRequestError('This file is no longer available. Refresh your notes.');
        if (!isNewSourceName(operation.source)) throw new DeckRequestError('New filenames must use file_name.md without a folder path.');
        handle = await root.getFileHandle(operation.source, { create: true });
      }
      const before = await (await handle.getFile()).text();
      const change = planContent(before, operation);
      if (operation.action === 'remove') {
        await archiveRemoval(change.removed);
        if (await (await handle.getFile()).text() !== before) throw new DeckRequestError('The source changed after archival. Check removed.md and refresh before retrying.');
      } else if (await (await handle.getFile()).text() !== before) throw new DeckRequestError('The source changed during saving. Refresh and try again.');
      await write(handle, change.text);
      sources.set(operation.source, handle);
      const file = await handle.getFile();
      return project(deck, operation, `${file.lastModified}:${file.size}`, change.text);
    } catch (error) { report(error); }
    finally { saving = false; }
  }
  return { load, mutate };
}

export async function pickLocalFolder(): Promise<{ backend: DeckBackend; name: string }> {
  const picker = (window as Window & { showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<Directory> }).showDirectoryPicker;
  if (!picker) throw new DeckRequestError('Direct folder access requires a supported Chromium browser. Firefox and Safari cannot save changes to a selected folder.');
  try {
    const folder = await picker.call(window, { mode: 'readwrite' });
    return { backend: createLocalFolderBackend(folder), name: folder.name };
  }
  catch (error) { report(error); }
}
