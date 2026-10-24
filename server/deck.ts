import { stat } from 'node:fs/promises';
import { createMaterialLoader } from './materials.js';
import { watchMaterials } from './material-watcher.js';
import type { DeckState } from '../src/lib/types.js';

export async function createDeckStore(directory: string) {
  if (!(await stat(directory)).isDirectory()) throw new Error(`Materials path is not a directory: ${directory}`);
  const loader = createMaterialLoader(directory);
  const listeners = new Set<(state: DeckState) => void>();
  let state: DeckState = { cards: [], files: [], errors: [], updatedAt: '' };

  function publish(next: DeckState): void {
    state = next;
    for (const listener of listeners) listener(state);
  }

  async function reload(): Promise<void> {
    publish(await loader.load());
  }

  function reportFilesystemError(error: NodeJS.ErrnoException): void {
    publish({ ...state, cards: [], errors: [`File watcher failed: ${error.message}`] });
  }

  function subscribe(listener: (state: DeckState) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  const watcher = await watchMaterials(directory, reload, reportFilesystemError);
  try {
    await reload();
  } catch (error) {
    await watcher.close();
    throw error;
  }
  return { getState: () => state, subscribe, close: watcher.close };
}
