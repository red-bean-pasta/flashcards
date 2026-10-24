import path from 'node:path';
import { CardParseError, parseCards } from './parser.js';
import { isFilesystemError, MaterialReadError, readMaterial, scanMarkdown } from './filesystem.js';
import type { Card, DeckState } from '../src/lib/types.js';

type CachedMaterial = { text: string; cards: Card[] };

export function createMaterialLoader(directory: string, parse: typeof parseCards = parseCards) {
  const cache = new Map<string, CachedMaterial>();

  async function loadCards(filename: string, source: string): Promise<Card[]> {
    const text = await readMaterial(filename, source);
    const cached = cache.get(source);
    if (cached?.text === text) return cached.cards;
    const cards = parse(text, source);
    cache.set(source, { text, cards });
    return cards;
  }

  function pruneCache(sources: string[]): void {
    const retained = new Set(sources);
    for (const source of cache.keys()) if (!retained.has(source)) cache.delete(source);
  }

  async function collectMaterials(filenames: string[]): Promise<DeckState> {
    const cards: Card[] = [];
    const errors: string[] = [];
    const files = filenames.map(file => path.relative(directory, file).split(path.sep).join('/'));
    for (const [index, filename] of filenames.entries()) {
      try {
        cards.push(...await loadCards(filename, files[index]));
      } catch (error) {
        if (!(error instanceof CardParseError || error instanceof MaterialReadError)) throw error;
        errors.push(error.message);
      }
    }
    pruneCache(files);
    return { cards: errors.length ? [] : cards, files, errors, updatedAt: new Date().toISOString() };
  }

  async function load(): Promise<DeckState> {
    let filenames: string[];
    try {
      filenames = await scanMarkdown(directory);
    } catch (error) {
      if (!isFilesystemError(error)) throw error;
      return { cards: [], files: [], errors: [error.message], updatedAt: new Date().toISOString() };
    }
    return collectMaterials(filenames);
  }

  return { load };
}
