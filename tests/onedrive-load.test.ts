import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraphClient, type GraphItem } from '../src/lib/onedrive/graph.ts';
import { createOneDriveStore } from '../src/lib/onedrive/store.ts';
import { mapConcurrent } from '../src/lib/onedrive/concurrent-map.ts';
import { scanOneDriveFolder } from '../src/lib/onedrive/scan.ts';
import { createLoadBudget } from '../src/lib/load-budget.ts';
import type { FileSnapshot } from '../src/lib/onedrive/snapshot-cache.ts';

const pause = () => new Promise(resolve => setTimeout(resolve, 2));
const folder: GraphItem = { id: 'root', name: 'Cards', folder: {} };

function fixture(count = 28) {
  const files = Array.from({ length: count }, (_, i) => ({ id: `f${i}`, name: `${i}.md`, file: {}, eTag: 'v1', '@microsoft.graph.downloadUrl': `https://download.example/f${i}` }));
  const snapshots = new Map<string, FileSnapshot | null>();
  const contents = new Map<string, string>();
  const counts = { listing: 0, metadata: 0, download: 0, active: 0, peak: 0 };
  const graph = createGraphClient(async () => 'token', async input => {
    const url = new URL(String(input));
    counts.active++;
    counts.peak = Math.max(counts.peak, counts.active);
    try {
      await pause();
      if (url.pathname.endsWith('/children')) {
        counts.listing++;
        assert.match(url.search, /\$select=.*downloadUrl/);
        return Response.json({ value: files });
      }
      const file = files.find(item => item.id === url.pathname.split('/').at(-1));
      assert.ok(file);
      if (url.hostname === 'download.example') {
        counts.download++;
        return new Response(contents.get(file.id) ?? file.id + ':' + file.eTag);
      }
      counts.metadata++;
      return Response.json(file);
    } finally { counts.active--; }
  });
  const store = createOneDriveStore(graph, folder, (text, source) => [{ id: source, source, question: text, answer: '', questionHtml: '', answerHtml: '' }], {
    get: async name => snapshots.get(name),
    put: async (name, value) => { snapshots.set(name, value); },
    clear: async () => { snapshots.clear(); },
  });
  return { store, files, snapshots, counts, graph, contents };
}

test('28-file load overlaps requests, reuses metadata, and refresh downloads only changed identities or revisions', async () => {
  const f = fixture();
  const deck = await f.store.load();
  assert.equal(deck.cards.length, 28);
  assert.deepEqual(deck.cards.map(card => card.question), f.files.map(file => file.id + ':v1'));
  assert.equal(f.counts.listing, 1);
  assert.equal(f.counts.metadata, 28);
  assert.equal(f.counts.download, 28);
  assert.equal(f.counts.peak, 6);
  assert.equal((await f.store.load()).cards.length, 28);
  assert.equal(f.counts.listing, 2);
  assert.equal(f.counts.metadata, 28);
  assert.equal(f.counts.download, 28);
  f.files[0].eTag = 'v2';
  f.files[1].id = 'replacement';
  f.files[1]['@microsoft.graph.downloadUrl'] = 'https://download.example/replacement'; // same name/revision, different identity must not hit cache
  f.files.splice(2, 1);
  const updated = await f.store.load();
  assert.equal(updated.cards.length, 27);
  assert.equal(updated.cards[0].question, 'f0:v2');
  assert.equal(updated.cards[1].question, 'replacement:v1');
  assert.equal(updated.files.includes('2.md'), false);
  assert.equal(f.counts.metadata, 30);
  assert.equal(f.counts.download, 30);
});

test('root archive is reused from the listing and obeys the same revision cache', async () => {
  const f = fixture(1);
  f.files[0].name = 'removed.md';
  assert.equal((await f.store.load()).cards.length, 0);
  await f.store.load();
  assert.equal(f.counts.listing, 2);
  assert.equal(f.counts.download, 1);
  assert.equal(f.snapshots.get('removed.md')?.text, 'f0:v1');
  f.files.splice(0, 1);
  await f.store.load();
  assert.equal(f.snapshots.get('removed.md'), null);
});

test('parallel folder scan preserves depth-first source order despite out-of-order responses', async () => {
  let active = 0, peak = 0;
  const leaf = (id: string): GraphItem => ({ id, name: id + '.md', file: {} });
  const child = (id: string): GraphItem => ({ id, name: id, folder: {} });
  const tree: Record<string, GraphItem[]> = { root: [child('a'), leaf('root-note'), child('b')], a: [leaf('a-note')], b: [leaf('b-note')] };
  const graph = { children: async (id: string) => {
    active++; peak = Math.max(peak, active);
    await pause(); active--;
    return tree[id];
  } } as ReturnType<typeof createGraphClient>;
  const scan = await scanOneDriveFolder(graph, folder, createLoadBudget());
  assert.deepEqual([...scan.sources.keys()], ['a/a-note.md', 'root-note.md', 'b/b-note.md']);
  assert.equal(peak, 2);
  tree.a = [folder];
  await assert.rejects(scanOneDriveFolder(graph, folder, createLoadBudget()), /recursive folder/);
});

test('concurrent workers preserve internal failures, abort siblings, and drain before rejection', async () => {
  const bug = new Error('cache failed');
  let drained = false;
  let started = 0;
  await assert.rejects(mapConcurrent([0, 1, 2], async (item, signal) => {
    started++;
    if (item === 0) { await pause(); throw bug; }
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await pause(); drained = true;
    signal.throwIfAborted();
  }, undefined, 2), error => error === bug);
  assert.equal(started, 2);
  assert.equal(drained, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mapConcurrent([0], async () => { throw new Error('must not start'); }, controller.signal), { name: 'AbortError' });
  await assert.rejects(mapConcurrent([], async () => 0, undefined, 0), TypeError);
});

test('parallel streams share the aggregate download budget', async () => {
  const budget = createLoadBudget();
  const chunk = new Uint8Array(1024 * 1024);
  let consumed = 0;
  const graph = createGraphClient(async () => 'token', async input => {
    const url = new URL(String(input));
    if (url.hostname !== 'download.example') return Response.json({ id: 'f', name: 'f.md', file: {}, eTag: 'v1', '@microsoft.graph.downloadUrl': 'https://download.example/f' });
    return new Response(new ReadableStream({
      pull(controller) { consumed++; controller.enqueue(chunk); },
    }, { highWaterMark: 0 }));
  });
  // Two individually permitted streams must still fail at the shared total bound.
  await assert.rejects(mapConcurrent([0, 1], async (_, signal) => {
    await graph.readText('f', signal, 50 * 1024 * 1024, { onBytes: budget.transfer });
  }), error => error instanceof AggregateError
    ? error.errors.every(item => item instanceof Error && /50 MiB total limit/.test(item.message))
    : error instanceof Error && /50 MiB total limit/.test(error.message));
  assert.ok(consumed <= 52, `Unexpected excess streaming: ${consumed} MiB`);
});

test('archive obeys the same per-file limit as other Markdown files', async () => {
  const f = fixture(1);
  f.files[0].name = 'removed.md';
  f.contents.set('f0', 'x'.repeat(5 * 1024 * 1024 + 1));
  await assert.rejects(f.store.load(), /download limit/);
  assert.equal(f.snapshots.has('removed.md'), false);
});

test('independent sibling defects remain visible after the first worker failure', async () => {
  const first = new Error('first defect');
  const second = new TypeError('independent defect');
  await assert.rejects(mapConcurrent([0, 1], async (item, signal) => {
    if (item === 0) { await pause(); throw first; }
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw second;
  }), error => error instanceof AggregateError && error.errors[0] === first && error.errors[1] === second);
});
