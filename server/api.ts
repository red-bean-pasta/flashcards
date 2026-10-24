import type { Express, Request, Response } from 'express';
import type { createDeckStore } from './deck.js';

type DeckStore = Awaited<ReturnType<typeof createDeckStore>>;

function streamDeckEvents(req: Request, res: Response, store: DeckStore): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = () => res.write('event: deck\ndata: changed\n\n');
  const unsubscribe = store.subscribe(send);
  send();
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
}

export function registerDeckApi(app: Express, store: DeckStore): void {
  app.get('/api/deck', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(store.getState());
  });
  app.get('/api/events', (req, res) => streamDeckEvents(req, res, store));
}
