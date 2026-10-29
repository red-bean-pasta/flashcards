import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOneDrivePicker } from '../src/lib/onedrive/picker.ts';

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

test('persistent picker validates initialization and handles repeated selections', async () => {
  const env = setup();
  try {
    const selected: string[] = [];
    let closes = 0;
    const picker = createOneDrivePicker(env.frame, async () => 'personal-token', async folder => { selected.push(folder.id); }, () => { closes++; }, error => { throw error; });
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
    for (const id of ['first', 'second']) {
      env.command({ type: 'command', id, data: { command: 'pick', items: [{ id, parentReference: { driveId: 'drive' } }] } });
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.deepEqual(selected, ['first', 'second']);
    assert.equal(closes, 2);
    env.command({ type: 'command', id: 'close', data: { command: 'close' } });
    assert.equal(closes, 3);
    picker.dispose();
  } finally { env.restore(); }
});

test('selection remains in flight until completed and errors are reported', async () => {
  const env = setup();
  try {
    let failSelection!: (error: Error) => void;
    let reported: unknown;
    let closes = 0;
    const picker = createOneDrivePicker(env.frame, async () => 'token', () => new Promise<void>((_, reject) => { failSelection = reject; }), () => { closes++; }, error => { reported = error; });
    await new Promise(resolve => setImmediate(resolve));
    const channelId = JSON.parse(new URL(env.getForm().action).searchParams.get('filePicker')!).messaging.channelId;
    env.initialize({ origin: 'https://onedrive.live.com', source: env.source, data: { type: 'initialize', channelId }, ports: [env.port] });
    env.command({ type: 'command', id: 'pick', data: { command: 'pick', items: [{ id: 'folder', parentReference: { driveId: 'drive' } }] } });
    assert.equal(picker.isSelecting(), true);
    env.command({ type: 'command', id: 'close', data: { command: 'close' } });
    assert.equal(closes, 0);
    const failure = new Error('selection failed');
    failSelection(failure);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reported, failure);
    assert.equal(picker.isSelecting(), false);
  } finally { env.restore(); }
});

test('disposing before token acquisition prevents submission', async () => {
  const env = setup();
  try {
    let supply!: (token: string) => void;
    const picker = createOneDrivePicker(env.frame, () => new Promise(resolve => { supply = resolve; }), async () => {}, () => {}, error => { throw error; });
    picker.dispose();
    supply('token');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.getForm(), undefined);
  } finally { env.restore(); }
});
