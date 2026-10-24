import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeckStore } from './deck.js';
import { registerDeckApi } from './api.js';

const production = !import.meta.url.endsWith('.ts');
const projectRoot = fileURLToPath(new URL(production ? '../..' : '..', import.meta.url));
const materials = path.resolve(projectRoot, process.env.MATERIALS_DIR ?? 'materials');
const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const store = await createDeckStore(materials);
const app = express();
app.disable('x-powered-by');
registerDeckApi(app, store);
let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
if (production) {
  app.use(express.static(path.join(projectRoot, 'dist')));
} else {
  const { createServer } = await import('vite');
  vite = await createServer({ root: projectRoot, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = app.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Flashcards: http://${process.env.HOST ?? '127.0.0.1'}:${port}\nMaterials: ${materials}`);
});
async function close() {
  server.close();
  server.closeAllConnections();
  await store.close();
  await vite?.close();
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
