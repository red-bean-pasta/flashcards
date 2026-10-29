import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { createOneDriveAuth, OneDriveAuthError } from '../src/lib/onedrive/auth.ts';

function setup() {
  const values = new Map<string, string>();
  let time = 1_000_000;
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  let transport: typeof fetch = async () => Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600 });
  let navigation = '';
  const location = { href: 'https://cards.example/app', assign(url: string | URL) { navigation = String(url); } };
  const auth = createOneDriveAuth({ clientId: 'test-client', redirectUri: 'https://cards.example/app' }, {
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } },
    location, history: { replaceState(_data, _unused, url) { location.href = String(url); } },
    crypto: webcrypto as Crypto, now: () => time,
    fetch: async (url, init) => { calls.push({ url: String(url), body: new URLSearchParams(init?.body as URLSearchParams) }); return transport(url, init); },
  });
  async function callback() {
    await auth.startSignIn();
    const params = new URL(navigation).searchParams;
    location.href = `https://cards.example/app?code=one-use-code&state=${params.get('state')}&session_state=opaque`;
    return params;
  }
  return { auth, values, location, calls, callback, navigate: () => navigation, advance: (ms: number) => { time += ms; },
    transport: (fn: typeof fetch) => { transport = fn; } };
}

test('personal-account sign-in uses S256 PKCE, state, delegated scopes and session-only tokens', async () => {
  const s = setup();
  const params = await s.callback();
  assert.equal(new URL(s.navigate()).pathname, '/consumers/oauth2/v2.0/authorize');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('scope'), 'offline_access https://graph.microsoft.com/Files.ReadWrite');
  assert.equal(await s.auth.completeSignIn(), true);
  assert.equal(s.location.href, 'https://cards.example/app');
  const body = s.calls[0].body;
  assert.equal(body.get('client_secret'), null);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), params.get('code_challenge'));
  assert.equal(await s.auth.getAccessToken(), 'access');
  assert.equal(s.calls.length, 1);
  assert.equal(s.auth.isConnected(), true);
  assert.ok([...s.values.keys()].every(key => !key.endsWith('pending')));
  assert.equal(await s.auth.completeSignIn(), false);
  s.auth.disconnect();
  assert.equal(s.values.size, 0);
  assert.equal(s.auth.isConnected(), false);
  await assert.rejects(s.auth.getAccessToken(), error => error instanceof OneDriveAuthError && error.reconnectRequired);
});

test('rejects missing, mismatched and expired state before exchanging a code', async () => {
  for (const mode of ['missing', 'mismatched', 'expired']) {
    const s = setup();
    await s.callback();
    if (mode === 'missing') s.values.clear();
    if (mode === 'mismatched') s.location.href = 'https://cards.example/app?code=attacker-code&state=wrong';
    if (mode === 'expired') s.advance(11 * 60_000);
    await assert.rejects(s.auth.completeSignIn(), error => error instanceof OneDriveAuthError && error.reconnectRequired);
    assert.equal(s.calls.length, 0);
    assert.equal(s.location.href, 'https://cards.example/app');
  }
});

test('denied consent is explicit and clears callback credentials', async () => {
  const s = setup();
  const params = await s.callback();
  s.location.href = `https://cards.example/app?error=access_denied&state=${params.get('state')}&error_description=private`;
  await assert.rejects(s.auth.completeSignIn(), /access_denied/);
  assert.equal(s.calls.length, 0);
  assert.equal(s.location.href, 'https://cards.example/app');
});

test('refresh is coalesced, replaces rotating refresh token and requires reconnect on invalid_grant', async () => {
  const s = setup();
  await s.callback();
  await s.auth.completeSignIn();
  s.advance(3_600_000);
  s.transport(async () => Response.json({ access_token: 'second', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 }));
  assert.deepEqual(await Promise.all([s.auth.getAccessToken(), s.auth.getAccessToken()]), ['second', 'second']);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].body.get('refresh_token'), 'refresh');
  s.transport(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
  await assert.rejects(s.auth.getAccessToken(true), error => error instanceof OneDriveAuthError && error.reconnectRequired);
  assert.equal(s.calls[2].body.get('refresh_token'), 'rotated');
  assert.equal(s.auth.isConnected(), false);
});

test('token response and network failures remain explicit; programming errors preserve identity', async () => {
  for (const transport of [async () => new Response('{'), async () => Response.json({ access_token: 'bad' }),
    async () => Response.json({ error: 'invalid_client' }, { status: 400 }), async () => { throw new TypeError('offline'); }]) {
    const s = setup();
    await s.callback();
    s.transport(transport);
    await assert.rejects(s.auth.completeSignIn(), OneDriveAuthError);
    assert.equal(s.auth.isConnected(), false);
  }
  const s = setup();
  await s.callback();
  const bug = new Error('transport contract bug');
  s.transport(async () => { throw bug; });
  await assert.rejects(s.auth.completeSignIn(), error => error === bug);
});

test('disconnect prevents a pending token response from restoring the session', async () => {
  const s = setup();
  await s.callback();
  let resolve!: (response: Response) => void;
  s.transport(() => new Promise<Response>(r => { resolve = r; }));
  const pending = s.auth.completeSignIn();
  s.auth.disconnect();
  resolve(Response.json({ access_token: 'late', token_type: 'Bearer', expires_in: 3600 }));
  await assert.rejects(pending, error => error instanceof OneDriveAuthError && error.reconnectRequired);
  assert.equal(s.auth.isConnected(), false);
});

test('configuration rejects non-browser redirect targets and malformed cached sessions', async () => {
  assert.throws(() => createOneDriveAuth({ clientId: '', redirectUri: 'https://cards.example' }), /CLIENT_ID/);
  assert.throws(() => createOneDriveAuth({ clientId: 'id', redirectUri: 'http://example.com' }), /HTTPS/);
  const s = setup();
  await s.callback();
  await s.auth.completeSignIn();
  for (const key of s.values.keys()) s.values.set(key, '{');
  assert.throws(() => s.auth.isConnected(), error => error instanceof OneDriveAuthError && error.code === 'storage');
});

test('transient refresh failures preserve session and refresh tokens may be omitted on rotation', async () => {
  const s = setup();
  await s.callback();
  await s.auth.completeSignIn();
  s.advance(3_600_000);
  s.transport(async () => { throw new TypeError('offline'); });
  await assert.rejects(s.auth.getAccessToken(), error => error instanceof OneDriveAuthError && error.code === 'network');
  assert.equal(s.auth.isConnected(), true);
  s.transport(async () => Response.json({ access_token: 'renewed', token_type: 'Bearer', expires_in: 3600 }));
  assert.equal(await s.auth.getAccessToken(), 'renewed');
  assert.equal(await s.auth.getAccessToken(true), 'renewed');
  assert.equal(s.calls.at(-1)!.body.get('refresh_token'), 'refresh');
});

test('a callback cannot be replayed after its one-use pending state is consumed', async () => {
  const s = setup();
  await s.callback();
  const original = s.location.href;
  await s.auth.completeSignIn();
  s.location.href = original;
  await assert.rejects(s.auth.completeSignIn(), error => error instanceof OneDriveAuthError && error.reconnectRequired);
  assert.equal(s.calls.length, 1);
});

test('unavailable session storage is actionable and consumed-body contract errors propagate', async () => {
  const s = setup();
  await s.callback();
  const response = Response.json({});
  await response.text();
  s.transport(async () => response);
  await assert.rejects(s.auth.completeSignIn(), error => error instanceof TypeError && !(error instanceof OneDriveAuthError));
  const storageError = new DOMException('blocked', 'SecurityError');
  const auth = createOneDriveAuth({ clientId: 'id', redirectUri: 'https://cards.example/app' }, {
    location: s.location, history: { replaceState() {} },
    storage: { getItem() { throw storageError; }, setItem() {}, removeItem() {} },
  });
  assert.throws(() => auth.isConnected(), error => error instanceof OneDriveAuthError && error.code === 'storage' && error.cause === storageError);
});

test('picker uses its own interactive authorization and preserves the Graph session', async () => {
  const s = setup();
  await s.callback();
  await s.auth.completeSignIn();
  assert.equal(s.auth.hasPickerAuthorization(), false);
  await s.auth.startPickerSignIn();
  const params = new URL(s.navigate()).searchParams;
  assert.equal(params.get('scope'), 'offline_access OneDrive.ReadWrite');
  s.location.href = `https://cards.example/app?code=picker-code&state=${params.get('state')}`;
  s.transport(async () => Response.json({ access_token: 'picker', refresh_token: 'picker-refresh', token_type: 'Bearer', expires_in: 3600 }));
  await s.auth.completeSignIn();
  assert.equal(s.calls[1].body.get('scope'), 'offline_access OneDrive.ReadWrite');
  assert.equal(await s.auth.getPickerToken(), 'picker');
  assert.equal(await s.auth.getAccessToken(), 'access');
  s.advance(3_600_000);
  s.transport(async () => Response.json({ access_token: 'picker-new', token_type: 'Bearer', expires_in: 3600 }));
  assert.equal(await s.auth.getPickerToken(), 'picker-new');
  assert.equal(s.calls[2].body.get('refresh_token'), 'picker-refresh');
  await s.callback();
  await s.auth.completeSignIn();
  assert.equal(s.auth.hasPickerAuthorization(), false, 'Graph reconnection invalidates picker authorization');
  s.auth.disconnect();
});
