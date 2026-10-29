import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openOneDrivePicker } from '../src/lib/onedrive/picker.ts';

function setup() {
  const original = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
  let initialize!: (event: MessageEvent) => void;
  let command!: (event: MessageEvent) => void;
  let form: any;
  const sent: any[] = [];
  const source = {};
  const frame = { name: '', contentWindow: source } as HTMLIFrameElement;
  const port = { addEventListener: (_: string, fn: typeof command) => { command = fn; }, start() {}, close() {}, postMessage: (value: unknown) => sent.push(value) };
  const fakeDocument = { createElement: (tag: string) => tag === 'form' ? (form = { append() {}, submit() {}, remove() {} }) : {}, body: { append() {} } };
  const fakeWindow = { addEventListener: (_: string, fn: typeof initialize) => { initialize = fn; }, removeEventListener() {} };
  Object.assign(globalThis, { window: fakeWindow, document: fakeDocument, location: { origin: 'http://localhost:3000' } });
  return { frame, source, port, sent, getForm: () => form, initialize: (event: any) => initialize(event), command: (data: any) => command({ data } as MessageEvent), restore: () => Object.assign(globalThis, original) };
}

test('embedded consumer picker validates initialization and handles authentication and selection', async () => {
  const env = setup();
  try {
    let selected = '';
    const result = openOneDrivePicker(env.frame, new AbortController().signal, async () => 'personal-token', async folder => { selected = folder.id; });
    await new Promise(resolve => setImmediate(resolve));
    const form = env.getForm();
    const url = new URL(form.action);
    assert.equal(url.origin + url.pathname, 'https://onedrive.live.com/picker');
    assert.equal(form.method, 'POST');
    assert.equal(form.target, env.frame.name);
    const channelId = JSON.parse(url.searchParams.get('filePicker')!).messaging.channelId;
    const event = { origin: 'https://onedrive.live.com', source: env.source, data: { type: 'initialize', channelId }, ports: [env.port] };
    env.initialize({ ...event, origin: 'https://evil.example' });
    env.initialize({ ...event, source: {} });
    env.initialize({ ...event, data: { ...event.data, channelId: 'wrong' } });
    assert.equal(env.sent.length, 0);
    env.initialize(event);
    env.command({ type: 'command', id: 'auth', data: { command: 'authenticate' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(env.sent.at(-1), { type: 'result', id: 'auth', data: { result: 'token', token: 'personal-token' } });
    env.command({ type: 'command', id: 'pick', data: { command: 'pick', items: [{ id: 'folder-id', parentReference: { driveId: 'drive-id' } }] } });
    await result;
    assert.equal(selected, 'folder-id');
  } finally { env.restore(); }
});

test('cancellation waits for an in-flight selection and preserves its failure', async () => {
  const env = setup();
  try {
    const controller = new AbortController();
    let failSelection!: (error: Error) => void;
    const result = openOneDrivePicker(env.frame, controller.signal, async () => 'token', () => new Promise<void>((_, reject) => { failSelection = reject; }));
    await new Promise(resolve => setImmediate(resolve));
    const channelId = JSON.parse(new URL(env.getForm().action).searchParams.get('filePicker')!).messaging.channelId;
    env.initialize({ origin: 'https://onedrive.live.com', source: env.source, data: { type: 'initialize', channelId }, ports: [env.port] });
    env.command({ type: 'command', id: 'pick', data: { command: 'pick', items: [{ id: 'folder', parentReference: { driveId: 'drive' } }] } });
    controller.abort();
    const failure = new Error('selection failed');
    failSelection(failure);
    await assert.rejects(result, failure);
  } finally { env.restore(); }
});

test('cancellation before token acquisition prevents submission', async () => {
  const env = setup();
  try {
    const controller = new AbortController();
    let supply!: (token: string) => void;
    const result = openOneDrivePicker(env.frame, controller.signal, () => new Promise(resolve => { supply = resolve; }), async () => {});
    controller.abort();
    supply('token');
    await result;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.getForm(), undefined);
  } finally { env.restore(); }
});
