import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraphClient, GraphError } from '../src/lib/onedrive/graph.ts';

const BASE = 'https://graph.microsoft.com/v1.0';
const file = (eTag = 'r1', extra = {}) => ({ id: 'f', name: 'cards.md', file: {}, eTag, '@microsoft.graph.downloadUrl': 'https://variable-provider.example/signed', ...extra });
function fake(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const result = responses.shift();
    if (!result) throw new Error('Unexpected request');
    if (result instanceof Error) throw result;
    return result;
  };
  return { client: createGraphClient(async () => 'secret', fetcher), calls };
}
const failure = (status: number, code = 'failure', headers = {}) => Response.json({ error: { code } }, { status, headers });

test('children consumes all pages; findChild distinguishes absence from HTTP failure', async () => {
  const { client, calls } = fake([
    Response.json({ value: [{ id: 'a', name: 'a', folder: {} }], '@odata.nextLink': `${BASE}/me/drive/items/p/children?$skiptoken=next` }),
    Response.json({ value: [file()] }),
    Response.json({ value: [] }), failure(404, 'itemNotFound'),
  ]);
  assert.deepEqual((await client.children('p')).map(item => item.id), ['a', 'f']);
  assert.match(calls[1].url, /skiptoken=next/);
  assert.equal(await client.findChild('p', 'missing'), null);
  await assert.rejects(client.findChild('p', 'missing'), error => error instanceof GraphError && error.status === 404);
});

test('untrusted pagination never receives bearer token', async () => {
  for (const next of ['https://evil.example/v1.0/items', 'https://graph.microsoft.com.evil.example/v1.0/items', 'http://graph.microsoft.com/v1.0/items', 'https://graph.microsoft.com/beta/items', 'https://secret@graph.microsoft.com/v1.0/items']) {
    const { client, calls } = fake([Response.json({ value: [], '@odata.nextLink': next })]);
    await assert.rejects(client.children('p'), error => error instanceof GraphError && error.code === 'unsafePagination');
    assert.equal(calls.length, 1);
  }
});

test('stable read discards raced content and pairs text with the resulting eTag', async () => {
  const { client, calls } = fake([
    Response.json(file()), new Response('old'), Response.json(file('r2')),
    Response.json(file('r2')), new Response('new'), Response.json(file('r2')),
  ]);
  assert.deepEqual(await client.readText('f'), { id: 'f', text: 'new', revision: 'r2' });
  assert.equal(calls.length, 6);
  for (const index of [1, 4]) {
    assert.equal(new Headers(calls[index].init.headers).has('Authorization'), false);
    assert.equal(calls[index].url, 'https://variable-provider.example/signed');
  }
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Bearer secret');
});

test('stable read is bounded and refuses missing eTags, folders and insecure downloads', async () => {
  const responses: Response[] = [];
  for (let attempt = 0; attempt < 3; attempt++) responses.push(Response.json(file('before')), new Response('text'), Response.json(file('after')));
  const { client, calls } = fake(responses);
  await assert.rejects(client.readText('f'), error => error instanceof GraphError && error.code === 'unstableRead');
  assert.equal(calls.length, 9);
  for (const value of [file(undefined, { eTag: undefined }), { id: 'f', name: 'folder', folder: {}, eTag: 'r' }, file('r', { '@microsoft.graph.downloadUrl': 'http://example.com/download' })]) {
    const { client: invalid, calls: attempts } = fake([Response.json(value)]);
    await assert.rejects(invalid.readText('f'), GraphError);
    assert.equal(attempts.length, 1);
  }
});

test('conditional replacement sends If-Match once and exposes stale conflicts without fallback', async () => {
  for (const status of [409, 412]) {
    const { client, calls } = fake([failure(status, 'preconditionFailed')]);
    await assert.rejects(client.replaceText('f', '"old"', 'replacement'), error => error instanceof GraphError && error.status === status && !error.uncertain);
    assert.equal(calls.length, 1);
    assert.equal(new Headers(calls[0].init.headers).get('If-Match'), '"old"');
    assert.equal(calls[0].init.body, 'replacement');
  }
});

test('write outcomes are unknown on network, server and invalid success responses and never retried', async () => {
  for (const outcome of [new TypeError('offline'), failure(503), new Response('{'), Response.json({}), Response.json(file('r', { id: 'wrong' })), Response.json(file('r', { file: null }))]) {
    const { client, calls } = fake([outcome]);
    await assert.rejects(client.replaceText('f', 'old', 'new'), error => error instanceof GraphError && error.uncertain);
    assert.equal(calls.length, 1);
  }
  const bug = new Error('Internal transport defect');
  const { client } = fake([bug]);
  await assert.rejects(client.replaceText('f', 'old', 'new'), error => error === bug);
});

test('create methods fail on collisions and encode IDs and names as individual path segments', async () => {
  const { client, calls } = fake([
    Response.json({ id: 'new', name: 'folder', folder: {} }),
    Response.json(file()), failure(409, 'nameAlreadyExists'),
  ]);
  await client.createFolder('parent/#', 'folder');
  assert.match(calls[0].url, /parent%2F%23\/children$/);
  assert.equal(JSON.parse(String(calls[0].init.body))['@microsoft.graph.conflictBehavior'], 'fail');
  await client.createFile('parent/#', 'name #?.md', 'text');
  assert.equal(calls[1].url, `${BASE}/me/drive/items/parent%2F%23:/name%20%23%3F.md:/content?@microsoft.graph.conflictBehavior=fail`);
  await assert.rejects(client.createFile('parent', 'existing', 'text'), error => error instanceof GraphError && error.status === 409 && !error.uncertain);
});

test('authorization and throttling require explicit reconnect/retry; root validates a folder', async () => {
  const { client, calls } = fake([failure(401), failure(429, 'tooManyRequests', { 'Retry-After': '17' }), Response.json(file())]);
  await assert.rejects(client.root(), /Reconnect/);
  await assert.rejects(client.root(), error => error instanceof GraphError && error.retryAfter === '17' && /Retry after 17/.test(error.message));
  await assert.rejects(client.root(), GraphError);
  assert.equal(calls.length, 3);
});

test('drive identity is read from the drive resource and validated', async () => {
  const { client } = fake([Response.json({ id: 'account-drive' }), Response.json({})]);
  assert.equal(await client.driveId(), 'account-drive');
  await assert.rejects(client.driveId(), GraphError);
});

function interruptedBody(error: Error, status = 200): Response {
  return new Response(new ReadableStream({ start(controller) { controller.error(error); } }), { status });
}

test('interrupted success JSON bodies classify network errors with original causes and no write retry', async () => {
  for (const cause of [new TypeError('socket closed after headers'), new DOMException('request aborted after headers', 'AbortError')]) {
    const write = fake([interruptedBody(cause)]);
    await assert.rejects(write.client.replaceText('f', 'old', 'new'), error => error instanceof GraphError && error.uncertain && error.code === 'networkError' && error.cause === cause);
    assert.equal(write.calls.length, 1);
    const read = fake([interruptedBody(cause)]);
    await assert.rejects(read.client.getItem('f'), error => error instanceof GraphError && !error.uncertain && error.code === 'networkError' && error.cause === cause);
  }
});

test('interrupted downloads and HTTP error bodies remain explicit recoverable failures', async () => {
  const cause = new TypeError('download disconnected');
  const read = fake([Response.json(file()), interruptedBody(cause)]);
  await assert.rejects(read.client.readText('f'), error => error instanceof GraphError && !error.uncertain && error.cause === cause);
  for (const status of [412, 503]) {
    const write = fake([interruptedBody(cause, status)]);
    await assert.rejects(write.client.replaceText('f', 'old', 'new'), error => error instanceof GraphError && error.status === status && error.uncertain === (status === 503) && error.cause === cause);
    assert.equal(write.calls.length, 1);
  }
});

test('malformed JSON keeps a syntax cause; unrelated body errors and consumed body contract errors propagate', async () => {
  const malformed = fake([new Response('{')]);
  await assert.rejects(malformed.client.replaceText('f', 'old', 'new'), error => error instanceof GraphError && error.uncertain && error.cause instanceof SyntaxError);
  const bug = new Error('Internal response reader defect');
  const internal = fake([interruptedBody(bug)]);
  await assert.rejects(internal.client.replaceText('f', 'old', 'new'), error => error === bug);
  const consumed = Response.json(file());
  await consumed.json();
  await assert.rejects(fake([consumed]).client.replaceText('f', 'old', 'new'), error => error instanceof TypeError && !(error instanceof GraphError));
});
