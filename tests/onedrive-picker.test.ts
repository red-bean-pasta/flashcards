import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openOneDrivePicker } from '../src/lib/onedrive/picker.ts';

test('consumer picker handles an authentication command and selects a folder', async () => {
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  let listener!: (event: MessageEvent) => void;
  let portListener!: (event: MessageEvent) => void;
  let pickerUrl = '';
  let selected = '';
  const sent: any[] = [];
  const port = { addEventListener: (_: string, fn: typeof portListener) => { portListener = fn; }, start() {}, close() {}, postMessage: (value: unknown) => sent.push(value) };
  const popup = { closed: false, close() { this.closed = true; }, document: {
    createElement: (tag: string) => tag === 'form' ? { method: '', action: '', append() {}, submit() { pickerUrl = this.action; } } : {},
    body: { append() {} },
  } };
  const fakeWindow = { open: () => popup, setInterval, clearInterval, addEventListener: (_: string, fn: typeof listener) => { listener = fn; }, removeEventListener() {} };
  Object.assign(globalThis, { window: fakeWindow, location: { origin: 'http://localhost:3000' } });
  try {
    const result = openOneDrivePicker(async () => 'personal-token', async folder => { selected = folder.id; });
    await new Promise(resolve => setImmediate(resolve));
    const url = new URL(pickerUrl);
    assert.equal(url.origin + url.pathname, 'https://onedrive.live.com/picker');
    const options = JSON.parse(url.searchParams.get('filePicker')!);
    listener({ origin: 'https://onedrive.live.com', source: popup, data: { type: 'initialize', channelId: options.messaging.channelId }, ports: [port] } as unknown as MessageEvent);
    portListener({ data: { type: 'command', id: 'auth', data: { command: 'authenticate', type: 'OneDrive' } } } as MessageEvent);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent.at(-1), { type: 'result', id: 'auth', data: { result: 'token', token: 'personal-token' } });
    portListener({ data: { type: 'command', id: 'pick', data: { command: 'pick', items: [{ id: 'folder-id', parentReference: { driveId: 'drive-id' } }] } } } as MessageEvent);
    await result;
    assert.equal(selected, 'folder-id');
  } finally {
    Object.assign(globalThis, { window: originalWindow, location: originalLocation });
  }
});

test('popup closing during selection waits for the selection failure', async () => {
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  let initialize!: (event: MessageEvent) => void;
  let onCommand!: (event: MessageEvent) => void;
  let poll!: () => void;
  let pickerUrl = '';
  let finishSelection!: (reason?: unknown) => void;
  const port = { addEventListener: (_: string, fn: typeof onCommand) => { onCommand = fn; }, start() {}, close() {}, postMessage() {} };
  const popup = { closed: false, close() { this.closed = true; }, document: {
    createElement: (tag: string) => tag === 'form' ? { method: '', action: '', append() {}, submit() { pickerUrl = this.action; } } : {},
    body: { append() {} },
  } };
  const fakeWindow = { open: () => popup, setInterval: (fn: typeof poll) => { poll = fn; return 1; }, clearInterval() {}, addEventListener: (_: string, fn: typeof initialize) => { initialize = fn; }, removeEventListener() {} };
  Object.assign(globalThis, { window: fakeWindow, location: { origin: 'http://localhost:3000' } });
  try {
    const result = openOneDrivePicker(async () => 'token', () => new Promise<void>((_, reject) => { finishSelection = reject; }));
    let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    const options = JSON.parse(new URL(pickerUrl).searchParams.get('filePicker')!);
    initialize({ origin: 'https://onedrive.live.com', source: popup, data: { type: 'initialize', channelId: options.messaging.channelId }, ports: [port] } as unknown as MessageEvent);
    onCommand({ data: { type: 'command', id: 'pick', data: { command: 'pick', items: [{ id: 'folder', parentReference: { driveId: 'drive' } }] } } } as MessageEvent);
    popup.closed = true;
    poll();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    finishSelection(undefined);
    await assert.rejects(result, error => error === undefined);
  } finally { Object.assign(globalThis, { window: originalWindow, location: originalLocation }); }
});
