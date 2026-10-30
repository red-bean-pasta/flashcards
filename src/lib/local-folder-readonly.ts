import { createLoadBudget } from './load-budget.js';
import { archiveFilename } from './card-text.js';
import { CardParseError } from './card-ranges.js';
import { parseBrowserCards } from './browser-cards.js';
import { DeckRequestError } from './deck-client.js';
import type { DeckBackend } from './deck-backend.js';
import type { DeckState } from './types.js';

export const readOnlyFolderMessage = 'This folder is read-only in your browser. To edit local files, use Chrome or Edge.';

/** File inputs provide a snapshot, so a new selection is needed to refresh. */
export function createReadOnlyFolderBackend(files: Iterable<File>, parse = parseBrowserCards): DeckBackend {
  const selected = [...files].filter(file => {
    const parts = file.webkitRelativePath.split('/').slice(1);
    return parts.length > 0 && parts.every(part => !part.startsWith('.')) &&
      parts.at(-1)!.toLowerCase() !== archiveFilename && /\.md$/i.test(parts.at(-1)!);
  });
  return {
    async load(signal?: AbortSignal): Promise<DeckState> {
      const budget = createLoadBudget();
      const cards: DeckState['cards'] = [];
      const errors: string[] = [];
      const revisions: Record<string, string> = {};
      for (const file of selected) {
        signal?.throwIfAborted();
        const source = file.webkitRelativePath.split('/').slice(1).join('/');
        budget.entry(source);
        budget.file(source, file.size);
        try { cards.push(...parse(await file.text(), source)); }
        catch (error) {
          if (error instanceof CardParseError) errors.push(error.message);
          else if (error instanceof DOMException) throw new DeckRequestError(error.message, { cause: error });
          else throw error;
        }
        revisions[source] = `${file.lastModified}:${file.size}`;
      }
      return { cards: errors.length ? [] : cards, files: Object.keys(revisions).sort(), revisions, errors };
    },
    async mutate() { throw new DeckRequestError(readOnlyFolderMessage); },
  };
}

/** The directory input exposes the selected root through each relative path. */
export function selectedFolderName(files: FileList): string {
  const first = files.item(0);
  if (!first) throw new Error('A folder name requires at least one selected file.');
  const parts = first.webkitRelativePath.split('/');
  if (parts.length < 2 || !parts[0]) throw new Error('Selected folder files must include their root in the relative path.');
  return parts[0];
}
