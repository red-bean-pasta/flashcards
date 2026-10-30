import { archiveFilename } from '../src/lib/card-text.js';
import path from 'node:path';
import { materialRevision } from './revision.js';
import { CardParseError, parseCards } from './parser.js';
import { isFilesystemError, MaterialReadError, readMaterial, scanMarkdown } from './filesystem.js';
import type { Card, DeckState } from '../src/lib/types.js';

type CachedMaterial = { text: string; cards: Card[]; revision: string };

export function createMaterialLoader(directory: string, parse: typeof parseCards = parseCards) {
  const cache = new Map<string, CachedMaterial>();

  async function loadMaterial(filename: string, source: string): Promise<CachedMaterial> {
    const text = await readMaterial(filename, source);
    const cached = cache.get(source);
    if (cached?.text === text) return cached;
    const material = { text, cards: parse(text, source), revision: materialRevision(text) };
    cache.set(source, material);
    return material;
  }

  function pruneCache(sources: string[]): void {
    const retained = new Set(sources);
    for (const source of cache.keys()) if (!retained.has(source)) cache.delete(source);
  }

  async function collectMaterials(filenames: string[]): Promise<DeckState> {
    const cards: Card[] = [];
    const errors: string[] = [];
    const revisions: Record<string, string> = {};
    const files = filenames.map(file => path.relative(directory, file).split(path.sep).join('/'));
    for (const [index, filename] of filenames.entries()) {
      try {
        const material = await loadMaterial(filename, files[index]);
        cards.push(...material.cards);
        revisions[files[index]] = material.revision;
      } catch (error) {
        if (!(error instanceof CardParseError || error instanceof MaterialReadError)) throw error;
        errors.push(error.message);
      }
    }
    pruneCache(files);
    return { cards: errors.length ? [] : cards, files, revisions, errors };
  }

  async function load(): Promise<DeckState> {
    let filenames: string[];
    try {
      filenames = (await scanMarkdown(directory)).filter(filename => path.basename(filename).toLowerCase() !== archiveFilename);
    } catch (error) {
      if (!isFilesystemError(error)) throw error;
      return { cards: [], files: [], revisions: {}, errors: [error.message] };
    }
    return collectMaterials(filenames);
  }

  return { load };
}
