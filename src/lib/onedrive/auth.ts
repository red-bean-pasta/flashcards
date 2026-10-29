/** Browser-only OAuth authorization-code flow for a personal OneDrive account. */
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPES = 'offline_access https://graph.microsoft.com/Files.ReadWrite';
const PICKER_SCOPES = 'offline_access OneDrive.ReadWrite';
const CONNECTION_SCOPES = `${SCOPES} OneDrive.ReadWrite`;
const PENDING_LIFETIME_MS = 10 * 60 * 1000;

export type OneDriveAuthErrorCode = 'configuration' | 'reconnect_required' | 'oauth' | 'network' | 'invalid_response' | 'storage';

export class OneDriveAuthError extends Error {
  readonly reconnectRequired: boolean;
  constructor(message: string, readonly code: OneDriveAuthErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OneDriveAuthError';
    this.reconnectRequired = code === 'reconnect_required';
  }
}

export interface OneDriveAuthConfig { clientId: string; redirectUri: string }
export interface OneDriveAuthDependencies {
  fetch?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  crypto?: Crypto;
  location?: Pick<Location, 'href' | 'assign'>;
  history?: Pick<History, 'replaceState'>;
  now?: () => number;
}
interface PendingSignIn { state: string; verifier: string; createdAt: number; purpose?: 'picker' }
interface Tokens { accessToken: string; refreshToken?: string; expiresAt: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPending(value: unknown): value is PendingSignIn {
  return isRecord(value) && typeof value.state === 'string' && value.state.length > 0
    && typeof value.verifier === 'string' && value.verifier.length >= 43
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    && (value.purpose === undefined || value.purpose === 'picker');
}
function isTokens(value: unknown): value is Tokens {
  return isRecord(value) && typeof value.accessToken === 'string' && value.accessToken.length > 0
    && (value.refreshToken === undefined || (typeof value.refreshToken === 'string' && value.refreshToken.length > 0))
    && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt);
}
function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function readJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw new OneDriveAuthError('Stored OneDrive session is invalid. Disconnect and reconnect OneDrive.', 'storage', { cause });
  }
}

export function createOneDriveAuth(config: OneDriveAuthConfig, dependencies: OneDriveAuthDependencies = {}) {
  if (!config.clientId.trim()) throw new OneDriveAuthError('Set VITE_ONEDRIVE_CLIENT_ID to a Microsoft application client ID.', 'configuration');
  let redirect: URL;
  try { redirect = new URL(config.redirectUri); }
  catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    throw new OneDriveAuthError('OneDrive redirect URI must be an absolute URL.', 'configuration', { cause });
  }
  if ((redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)))
      || redirect.search || redirect.hash || redirect.username || redirect.password) {
    throw new OneDriveAuthError('Use an HTTPS redirect URI (or HTTP localhost) without a query or fragment.', 'configuration');
  }
  const location = dependencies.location ?? window.location;
  const history = dependencies.history ?? window.history;
  const crypto = dependencies.crypto ?? globalThis.crypto;
  const request = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const prefix = `flashcards.onedrive.${encodeURIComponent(config.clientId)}.${encodeURIComponent(redirect.href)}.`;
  let generation = 0;
  let refreshing: Promise<string> | undefined;
  let tokenQueue: Promise<void> = Promise.resolve();

  // Only browser sessionStorage is used by default; dependency injection is for tests.
  function storageOperation<T>(operation: (storage: NonNullable<OneDriveAuthDependencies['storage']>) => T): T {
    try { return operation(dependencies.storage ?? window.sessionStorage); }
    catch (cause) {
      if (!(cause instanceof DOMException) || !['SecurityError', 'QuotaExceededError', 'InvalidStateError'].includes(cause.name)) throw cause;
      throw new OneDriveAuthError('Browser session storage is unavailable. Allow session storage to connect OneDrive.', 'storage', { cause });
    }
  }
  function readStored<T>(key: string, validate: (value: unknown) => value is T): T | undefined {
    const text = storageOperation(storage => storage.getItem(prefix + key));
    if (text === null) return undefined;
    const value = readJson(text);
    if (!validate(value)) throw new OneDriveAuthError('Stored OneDrive session has an invalid format. Disconnect and reconnect OneDrive.', 'storage');
    return value;
  }
  function saveStored(key: string, value: unknown) {
    storageOperation(storage => storage.setItem(prefix + key, JSON.stringify(value)));
  }
  function removeStored(key: string) { storageOperation(storage => storage.removeItem(prefix + key)); }
  function disconnect() {
    generation++;
    refreshing = undefined;
    removeStored('tokens');
    removeStored('pending');
    removeStored('pickerTokens');
  }
  function assertCurrent(expected: number) {
    if (generation !== expected) throw new OneDriveAuthError('OneDrive was disconnected while authentication was in progress. Reconnect to continue.', 'reconnect_required');
  }
  async function startSignIn(purpose?: 'picker'): Promise<void> {
    if (new URL(location.href).origin !== redirect.origin) throw new OneDriveAuthError('OneDrive redirect URI must use this app’s origin.', 'configuration');
    const expected = ++generation;
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    assertCurrent(expected);
    saveStored('pending', { state, verifier, createdAt: now(), ...(purpose ? { purpose } : {}) });
    const url = new URL(`${AUTHORITY}/authorize`);
    url.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', redirect_uri: redirect.href,
      response_mode: 'query', scope: purpose === 'picker' ? PICKER_SCOPES : CONNECTION_SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' }).toString();
    location.assign(url.href);
  }
  async function fetchToken(parameters: Record<string, string>, oldRefreshToken?: string, scope = SCOPES): Promise<Tokens> {
    let response: Response;
    try {
      response = await request(`${AUTHORITY}/token`, { method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, redirect_uri: redirect.href, scope, ...parameters }) });
    } catch (cause) {
      if (!(cause instanceof TypeError) && !(cause instanceof DOMException && cause.name === 'NetworkError')) throw cause;
      throw new OneDriveAuthError('Could not reach Microsoft sign-in. Check your connection and SPA redirect registration.', 'network', { cause });
    }
    const payload = await readTokenPayload(response);
    if (!response.ok) throw tokenRequestError(payload, response.status);
    return tokensFromPayload(payload, oldRefreshToken);
  }
  async function readTokenPayload(response: Response): Promise<unknown> {
    // Read separately so consumed-body programming errors retain their identity.
    const body = await response.text();
    try { return JSON.parse(body); }
    catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      throw new OneDriveAuthError('Microsoft returned an invalid authentication response.', 'invalid_response', { cause });
    }
  }
  function tokenRequestError(payload: unknown, status: number): OneDriveAuthError {
    const error = isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'token_request_failed';
    if (['invalid_grant', 'interaction_required', 'login_required', 'consent_required'].includes(error)) {
      return new OneDriveAuthError(`Microsoft requires you to reconnect OneDrive (${error}).`, 'reconnect_required');
    }
    return new OneDriveAuthError(`Microsoft sign-in failed (${error}, HTTP ${status}). Check the app registration and reconnect.`, 'oauth');
  }
  function tokensFromPayload(payload: unknown, oldRefreshToken?: string): Tokens {
    if (!isRecord(payload) || typeof payload.access_token !== 'string' || !payload.access_token
        || typeof payload.expires_in !== 'number' || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0
        || typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer'
        || (payload.refresh_token !== undefined && (typeof payload.refresh_token !== 'string' || !payload.refresh_token))) {
      throw new OneDriveAuthError('Microsoft returned an invalid authentication token response.', 'invalid_response');
    }
    return { accessToken: payload.access_token, refreshToken: payload.refresh_token as string | undefined ?? oldRefreshToken,
      expiresAt: now() + payload.expires_in * 1000 };
  }

  async function completeSignIn(): Promise<boolean> {
    const url = new URL(location.href);
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) return false;
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) {
      throw new OneDriveAuthError('Microsoft returned to an unexpected redirect URI.', 'oauth');
    }
    const query = new URLSearchParams(url.search);
    const pending = readStored('pending', isPending);
    removeStored('pending');
    for (const name of ['code', 'state', 'error', 'error_description', 'error_uri', 'session_state']) url.searchParams.delete(name);
    history.replaceState(null, '', url.href);
    return finishSignIn(pending, query);
  }
  async function finishSignIn(pending: PendingSignIn | undefined, query: URLSearchParams): Promise<boolean> {
    if (!pending || query.get('state') !== pending.state || now() - pending.createdAt > PENDING_LIFETIME_MS || now() < pending.createdAt) {
      throw new OneDriveAuthError('OneDrive sign-in state is missing, expired, or does not match. Reconnect OneDrive.', 'reconnect_required');
    }
    const error = query.get('error');
    if (error) throw new OneDriveAuthError(`Microsoft sign-in was not completed (${error}).`, 'oauth');
    const code = query.get('code');
    if (!code) throw new OneDriveAuthError('Microsoft did not return an authorization code.', 'oauth');
    const expected = generation;
    const tokens = await fetchToken({ grant_type: 'authorization_code', code, code_verifier: pending.verifier }, undefined, pending.purpose === 'picker' ? PICKER_SCOPES : SCOPES);
    assertCurrent(expected);
    if (pending.purpose !== 'picker') removeStored('pickerTokens');
    saveStored(pending.purpose === 'picker' ? 'pickerTokens' : 'tokens', tokens);
    return true;
  }
  async function refresh(tokens: Tokens): Promise<string> {
    if (!tokens.refreshToken) throw new OneDriveAuthError('OneDrive session expired. Reconnect OneDrive.', 'reconnect_required');
    const expected = generation;
    let replacement: Tokens;
    try { replacement = await fetchToken({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, tokens.refreshToken); }
    catch (error) {
      if (error instanceof OneDriveAuthError && error.reconnectRequired && expected === generation) removeStored('tokens');
      throw error;
    }
    assertCurrent(expected);
    saveStored('tokens', replacement);
    return replacement.accessToken;
  }
  async function getAccessToken(forceRefresh = false): Promise<string> {
    const tokens = readStored('tokens', isTokens);
    if (!tokens) throw new OneDriveAuthError('Connect OneDrive to continue.', 'reconnect_required');
    if (!forceRefresh && tokens.expiresAt > now() + 60_000) return tokens.accessToken;
    if (!refreshing) refreshing = enqueueTokenRequest(async () => {
      const current = readStored('tokens', isTokens);
      if (!current) throw new OneDriveAuthError('Connect OneDrive to continue.', 'reconnect_required');
      return refresh(current);
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  function enqueueTokenRequest<T>(operation: () => Promise<T>): Promise<T> {
    const result = tokenQueue.then(operation);
    tokenQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  function hasPickerAuthorization(): boolean { return readStored('pickerTokens', isTokens) !== undefined; }
  function getPickerToken(): Promise<string> {
    return enqueueTokenRequest(async () => {
      const pickerTokens = readStored('pickerTokens', isTokens);
      const tokens = pickerTokens ?? readStored('tokens', isTokens);
      if (!tokens) throw new OneDriveAuthError('Connect OneDrive to choose a folder.', 'reconnect_required');
      if (pickerTokens && pickerTokens.expiresAt > now() + 60_000) return pickerTokens.accessToken;
      if (!tokens.refreshToken) { removeStored('pickerTokens'); throw new OneDriveAuthError('Reconnect OneDrive to choose a folder.', 'reconnect_required'); }
      const expected = generation;
      let replacement: Tokens;
      try { replacement = await fetchToken({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, tokens.refreshToken, PICKER_SCOPES); }
      catch (error) {
        if (error instanceof OneDriveAuthError && error.reconnectRequired && expected === generation) removeStored('pickerTokens');
        throw error;
      }
      assertCurrent(expected);
      saveStored('pickerTokens', replacement);
      return replacement.accessToken;
    });
  }
  function isConnected(): boolean { return readStored('tokens', isTokens) !== undefined; }
  return { startSignIn, startPickerSignIn: () => startSignIn('picker'), completeSignIn, getAccessToken, getPickerToken, hasPickerAuthorization, disconnect, isConnected };
}

export type OneDriveAuth = ReturnType<typeof createOneDriveAuth>;
