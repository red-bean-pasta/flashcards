import express, { type Express } from 'express';
import { MutationError } from './mutations.js';
import { isFilesystemError } from './filesystem.js';
import { CardParseError } from './parser.js';
import type { createDeckStore } from './deck.js';

type DeckStore = Awaited<ReturnType<typeof createDeckStore>>;

export function registerDeckApi(app: Express, store: DeckStore): void {
  app.post('/api/cards', express.json({ limit: '1mb' }), async (req, res) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') { res.status(403).json({ error: 'Cross-site writes are not allowed.' }); return; }
    try { res.json(await store.mutate(req.body)); }
    catch (error) {
      if (error instanceof MutationError) { res.status(error.status).json({ error: error.message }); return; }
      if (error instanceof CardParseError || isFilesystemError(error)) {
        console.error(error);
        res.status(409).json({ error: `Could not save: ${error.message}. A removal may be pending recovery; refresh before retrying.` });
        return;
      }
      throw error;
    }
  });
  app.get('/api/deck', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await store.getState());
  });
}
