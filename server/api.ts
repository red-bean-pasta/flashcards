import type { Express } from 'express';
import type { createDeckStore } from './deck.js';

type DeckStore = Awaited<ReturnType<typeof createDeckStore>>;

export function registerDeckApi(app: Express, store: DeckStore): void {
  app.get('/api/deck', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await store.getState());
  });
}
