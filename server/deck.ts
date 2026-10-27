import { stat } from 'node:fs/promises';
import { createMutations } from './mutations.js';
import { createMaterialLoader } from './materials.js';

export async function createDeckStore(directory: string) {
  if (!(await stat(directory)).isDirectory()) throw new Error(`Materials path is not a directory: ${directory}`);
  const loader = createMaterialLoader(directory);
  const mutations = createMutations(directory);
  await mutations.recover();
  let pending: Promise<unknown> = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    // Callers receive the original failure; only the scheduling queue is released.
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  // Each request reads current files; open pages retain their own snapshot.
  return {
    getState: () => exclusive(async () => { await mutations.recover(); return loader.load(); }),
    mutate: (input: unknown) => exclusive(() => mutations.mutate(input)),
  };
}
