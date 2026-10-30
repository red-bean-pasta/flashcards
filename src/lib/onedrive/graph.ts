/** OneDrive Personal transport. Requests are intentionally never retried after a write. */
export interface GraphItem {
  id: string;
  name: string;
  eTag?: string;
  folder?: Record<string, unknown>;
  file?: Record<string, unknown>;
  parentReference?: { id?: string; driveId?: string };
  downloadUrl?: string;
}

/** Service failure metadata; status 0 denotes a transport or response-format failure. */
export interface GraphFailure {
  status: number;
  code: string;
  retryAfter?: string | null;
}

export class GraphError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: string | null;

  constructor(message: string, failure: GraphFailure, public readonly uncertain = false, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GraphError';
    this.status = failure.status;
    this.code = failure.code;
    this.retryAfter = failure.retryAfter ?? null;
  }
}

const BASE = 'https://graph.microsoft.com/v1.0';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function invalidResponse(write: boolean, cause?: unknown): GraphError {
  return new GraphError(write ? 'OneDrive returned an invalid save response; the save outcome is unknown. Refresh before trying again.' : 'OneDrive returned an invalid response.', { status: 0, code: 'invalidResponse' }, write, cause === undefined ? undefined : { cause });
}

function parseItem(value: unknown, write = false): GraphItem {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name) throw invalidResponse(write);
  for (const key of ['folder', 'file', 'parentReference'] as const) {
    if (value[key] !== undefined && !isRecord(value[key])) throw invalidResponse(write);
  }
  if (value.folder && value.file) throw invalidResponse(write);
  for (const key of ['eTag', '@microsoft.graph.downloadUrl'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key])) throw invalidResponse(write);
  }
  if (isRecord(value.parentReference)) {
    for (const key of ['id', 'driveId']) {
      if (value.parentReference[key] !== undefined && typeof value.parentReference[key] !== 'string') throw invalidResponse(write);
    }
  }
  return {
    id: value.id, name: value.name,
    ...(value.eTag !== undefined ? { eTag: value.eTag as string } : {}),
    ...(value.folder !== undefined ? { folder: value.folder as Record<string, unknown> } : {}),
    ...(value.file !== undefined ? { file: value.file as Record<string, unknown> } : {}),
    ...(value.parentReference !== undefined ? { parentReference: value.parentReference as GraphItem['parentReference'] } : {}),
    ...(value['@microsoft.graph.downloadUrl'] !== undefined ? { downloadUrl: value['@microsoft.graph.downloadUrl'] as string } : {}),
  };
}

function requireFolder(item: GraphItem, write = false): GraphItem {
  if (!item.folder) throw invalidResponse(write);
  return item;
}

function requireFile(item: GraphItem, write = false): GraphItem & { eTag: string } {
  if (!item.file || !item.eTag) throw invalidResponse(write);
  return item as GraphItem & { eTag: string };
}

function segment(value: string): string {
  if (!value || value === '.' || value === '..') throw new TypeError('An item ID or name must be a nonempty path segment.');
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function graphUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new GraphError('OneDrive returned an invalid pagination URL.', { status: 0, code: 'unsafePagination' });
  }
  if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/') || url.username || url.password || url.hash) {
    throw new GraphError('OneDrive returned an unsafe pagination URL.', { status: 0, code: 'unsafePagination' });
  }
  return url.href;
}

function downloadUrl(value: string | undefined): string {
  if (!value) throw invalidResponse(false);
  let url: URL;
  try { url = new URL(value); } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw invalidResponse(false);
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw invalidResponse(false);
  return url.href;
}

async function responseJson(response: Response, write: boolean): Promise<unknown> {
  if (response.bodyUsed) throw new TypeError('The OneDrive response body was already consumed.');
  try { return await response.json(); } catch (error) {
    if (error instanceof SyntaxError) throw invalidResponse(write, error);
    if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new GraphError(write ? 'The OneDrive save outcome is unknown. Refresh before trying again.' : 'The OneDrive response was interrupted. Try refreshing.', { status: 0, code: 'networkError' }, write, { cause: error });
  }
}

async function httpError(response: Response, write: boolean): Promise<GraphError> {
  let code = 'httpError';
  if (response.bodyUsed) throw new TypeError('The OneDrive error body was already consumed.');
  let raw = '';
  let bodyFailure: unknown;
  try { raw = await response.text(); } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'AbortError')) throw error;
    bodyFailure = error;
  }
  if (raw) {
    let value: unknown;
    try { value = JSON.parse(raw); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (isRecord(value) && isRecord(value.error) && typeof value.error.code === 'string') code = value.error.code;
  }
  const uncertain = write && response.status >= 500;
  const message = response.status === 401 ? 'OneDrive authorization expired. Reconnect to OneDrive.'
    : response.status === 429 ? `OneDrive is rate limited. Retry after ${response.headers.get('Retry-After') ?? 'the service allows another request'}.`
    : response.status === 409 || response.status === 412 ? 'OneDrive changed since this snapshot. Refresh before saving again.'
    : uncertain ? 'The OneDrive save outcome is unknown. Refresh before trying again.'
    : `OneDrive request failed (${response.status}).`;
  return new GraphError(message, { status: response.status, code, retryAfter: response.headers.get('Retry-After') }, uncertain, bodyFailure ? { cause: bodyFailure } : undefined);
}

async function downloadText(response: Response): Promise<string> {
  if (response.bodyUsed) throw new TypeError('The OneDrive download body was already consumed.');
  try { return await response.text(); } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new GraphError('The OneDrive download was interrupted. Try refreshing.', { status: 0, code: 'networkError' }, false, { cause: error });
  }
}

export function createGraphClient(getAccessToken: () => Promise<string>, fetcher: typeof fetch = fetch) {
  async function request(url: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    const write = init.method === 'PUT' || init.method === 'POST';
    const headers = new Headers(init.headers);
    // Validate before obtaining the bearer token or dispatching any request.
    if (authenticated) {
      url = graphUrl(url);
      headers.set('Authorization', `Bearer ${await getAccessToken()}`);
    }
    let response: Response;
    try { response = await fetcher(url, { ...init, headers, redirect: authenticated ? 'error' : 'follow' }); } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'AbortError')) throw error;
      throw new GraphError(write ? 'The OneDrive save outcome is unknown. Refresh before trying again.' : 'Could not reach OneDrive. Check your connection.', { status: 0, code: 'networkError' }, write, { cause: error });
    }
    if (!response.ok) throw await httpError(response, write);
    if (write && response.status !== 200 && response.status !== 201) throw invalidResponse(true);
    return response;
  }

  async function itemRequest(url: string, init?: RequestInit): Promise<GraphItem> {
    const write = init?.method === 'PUT' || init?.method === 'POST';
    const response = await request(url, init);
    return parseItem(await responseJson(response, write), write);
  }

  async function getItem(id: string, signal?: AbortSignal): Promise<GraphItem> {
    const item = await itemRequest(`${BASE}/me/drive/items/${segment(id)}`, { signal });
    if (item.id !== id) throw invalidResponse(false);
    return item;
  }

  async function children(id: string, signal?: AbortSignal): Promise<GraphItem[]> {
    let next: string | undefined = `${BASE}/me/drive/items/${segment(id)}/children`;
    const items: GraphItem[] = [];
    const visited = new Set<string>();
    while (next) {
      next = graphUrl(next);
      if (visited.has(next)) throw invalidResponse(false);
      visited.add(next);
      const value = await responseJson(await request(next, { signal }), false);
      if (!isRecord(value) || !Array.isArray(value.value)) throw invalidResponse(false);
      items.push(...value.value.map(item => parseItem(item)));
      const link = value['@odata.nextLink'];
      if (link !== undefined && (typeof link !== 'string' || !link)) throw invalidResponse(false);
      next = link as string | undefined;
    }
    return items;
  }

  async function readText(id: string, signal?: AbortSignal): Promise<{ id: string; text: string; revision: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = requireFile(await getItem(id, signal));
      const response = await request(downloadUrl(before.downloadUrl), { signal }, false);
      const text = await downloadText(response);
      const after = requireFile(await getItem(id, signal));
      if (before.eTag === after.eTag) return { id, text, revision: after.eTag };
    }
    throw new GraphError('OneDrive kept changing during the read. Refresh and try again.', { status: 409, code: 'unstableRead' });
  }

  return {
    async driveId(): Promise<string> {
      const value = await responseJson(await request(`${BASE}/me/drive`), false);
      if (!isRecord(value) || typeof value.id !== 'string' || !value.id) throw invalidResponse(false);
      return value.id;
    },
    root: async () => requireFolder(await itemRequest(`${BASE}/me/drive/root`)),
    getItem,
    children,
    async findChild(parentId: string, name: string): Promise<GraphItem | null> {
      const matches = (await children(parentId)).filter(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (matches.length > 1) throw invalidResponse(false);
      return matches[0] ?? null;
    },
    async createFolder(parentId: string, name: string): Promise<GraphItem> {
      segment(name);
      return requireFolder(await itemRequest(`${BASE}/me/drive/items/${segment(parentId)}/children`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      }), true);
    },
    async createFile(parentId: string, name: string, text: string): Promise<GraphItem> {
      return requireFile(await itemRequest(`${BASE}/me/drive/items/${segment(parentId)}:/${segment(name)}:/content?@microsoft.graph.conflictBehavior=fail`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text,
      }), true);
    },
    readText,
    /**
     * Prototype gate: simple PUT If-Match is observed on OneDrive Personal, but the
     * official upload/replace documentation omits this header. The user accepts this
     * prototype dependency. A failed conditional write must NEVER fall back to an
     * unconditional PUT. https://learn.microsoft.com/graph/api/driveitem-put-content
     */
    async replaceText(id: string, revision: string, text: string): Promise<GraphItem> {
      if (!revision) throw new TypeError('Replacing a file requires its snapshot eTag.');
      const item = requireFile(await itemRequest(`${BASE}/me/drive/items/${segment(id)}/content`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8', 'If-Match': revision }, body: text,
      }), true);
      if (item.id !== id) throw invalidResponse(true);
      return item;
    },
  };
}

export type GraphClient = ReturnType<typeof createGraphClient>;
