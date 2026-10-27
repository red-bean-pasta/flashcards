import { stat } from 'node:fs/promises';
import { createMaterialLoader } from './materials.js';

export async function createDeckStore(directory: string) {
  if (!(await stat(directory)).isDirectory()) throw new Error(`Materials path is not a directory: ${directory}`);
  const loader = createMaterialLoader(directory);
  // Each request reads current files; open pages retain their own snapshot.
  return { getState: loader.load };
}
