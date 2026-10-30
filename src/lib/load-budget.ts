import { DeckRequestError } from './deck-client.js';

const MAX_FILES = 2000;
const MAX_DEPTH = 32;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export function createLoadBudget() {
  let count = 0;
  let total = 0;
  return {
    entry(path: string) {
      if (path.split('/').length > MAX_DEPTH) throw new DeckRequestError(`Folder depth exceeds ${MAX_DEPTH}: ${path}`);
      if (++count > MAX_FILES) throw new DeckRequestError(`Folder contains more than ${MAX_FILES} entries. Choose a smaller folder.`);
    },
    file(path: string, bytes: number) {
      if (bytes > MAX_FILE_BYTES) throw new DeckRequestError(`${path} exceeds the 5 MiB file limit.`);
      total += bytes;
      if (total > MAX_TOTAL_BYTES) throw new DeckRequestError(`Markdown files exceed the 50 MiB total limit at ${path}.`);
    },
  };
}
