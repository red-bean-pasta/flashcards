import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraphClient, GraphError } from '../src/lib/onedrive/graph.ts';
import { parseBatchReplies, BatchResponseError, readMetadataBatches } from '../src/lib/onedrive/metadata-batch.ts';
const item = (id: string) => ({ id, name: id + '.md', file: {}, eTag: 'v1' });

test('metadata requests use groups of five and restore response order', async () => {
  const sizes: number[] = [];
  const graph = createGraphClient(async () => 'token', async (_, init) => {
    const body = JSON.parse(String(init?.body));
    sizes.push(body.requests.length);
    assert.ok(body.requests.every((part: any) => part.method === 'GET'));
    return Response.json({ responses: body.requests.map((part: any) => ({ id: part.id, status: 200, body: item(part.url.split('/').at(-1)) })).reverse() });
  });
  const ids = Array.from({ length: 28 }, (_, i) => 'f' + i);
  assert.deepEqual((await graph.getItems(ids)).map(value => value.id), ids);
  assert.deepEqual(sizes, [5,5,5,5,5,3]);
  await graph.getItems([]);
  assert.equal(sizes.length, 6);
});

test('batch protocol rejects missing, duplicate, foreign and malformed replies', () => {
  const valid = { id: '0', status: 200, body: item('f') };
  for (const responses of [[], [valid, valid], [{...valid,id:'wrong'}], [{...valid,status:'200'}], [{...valid,headers:[]}], [{...valid,headers:{bad:3}}]]) {
    assert.throws(() => parseBatchReplies({responses}, ['0']), BatchResponseError);
  }
});

test('per-item throttling preserves Retry-After; outer POST failures are read failures', async () => {
  for (const mode of ['item','outer','network']) {
    const graph = createGraphClient(async () => 'token', async () => {
      if (mode === 'network') throw new TypeError('offline');
      if (mode === 'outer') return Response.json({}, {status:503});
      return Response.json({responses:[{id:'0',status:429,headers:{'Retry-After':'17'},body:{error:{code:'tooManyRequests'}}}]});
    });
    await assert.rejects(graph.getItems(['f']), error => error instanceof GraphError && !error.uncertain && (mode !== 'item' || (error.status === 429 && error.retryAfter === '17')));
  }
});

test('invalid successful item bodies and malformed JSON remain explicit external errors', async () => {
  for (const response of [new Response('{'), Response.json({responses:[{id:'0',status:200,body:item('other')}]}), Response.json({responses:[{id:'0',status:304,body:{}}]})]) {
    const graph = createGraphClient(async () => 'token', async () => response);
    await assert.rejects(graph.getItems(['f']), error => error instanceof GraphError && error.code === 'invalidResponse');
  }
});

test('internal batch reader count violations fail loudly', async () => {
  await assert.rejects(readMetadataBatches(['a'], async () => []), /unexpected item count/);
});

test('large metadata sets never exceed ten concurrent batch HTTP tasks', async () => {
  let active = 0, peak = 0;
  const ids = Array.from({length: 103}, (_, index) => String(index));
  const result = await readMetadataBatches(ids, async group => {
    assert.ok(group.length <= 5);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return group;
  });
  assert.deepEqual(result, ids);
  assert.equal(peak, 10);
});
