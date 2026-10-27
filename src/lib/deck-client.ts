import type { Card, DeckState, MutationRequest, MutationResult } from './types';

export class DeckRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeckRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function isCard(value: unknown): value is Card {
  if (!isRecord(value)) return false;
  return ['id', 'source', 'question', 'answer', 'questionHtml', 'answerHtml']
    .every(key => typeof value[key] === 'string') &&
    Number.isInteger(value.line) && (value.line as number) > 0;
}

function parseDeckResponse(value: unknown): DeckState {
  if (!isRecord(value) || !Array.isArray(value.cards) || !value.cards.every(isCard) ||
      !isStringArray(value.files) || !isRecord(value.revisions) ||
      !Object.values(value.revisions).every(revision => typeof revision === 'string') || !isStringArray(value.errors)) {
    throw new DeckRequestError('The server returned an invalid deck response.');
  }
  if (value.errors.length && value.cards.length) {
    throw new DeckRequestError('The server returned cards alongside collection errors.');
  }
  const ids = value.cards.map(card => card.id);
  if (new Set(ids).size !== ids.length) {
    throw new DeckRequestError('The server returned duplicate card IDs.');
  }
  return { cards: value.cards, files: value.files, revisions: value.revisions as Record<string, string>, errors: value.errors };
}

async function requestDeck(fetcher: typeof fetch): Promise<Response> {
  try {
    return await fetcher('/api/deck', { cache: 'no-store' });
  } catch (error) {
    // Fetch uses TypeError for network failures. Other failures are not recovered.
    if (!(error instanceof TypeError)) throw error;
    throw new DeckRequestError('Could not reach the card server.', { cause: error });
  }
}

async function readResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new DeckRequestError('The server returned malformed JSON.', { cause: error });
  }
}

export async function fetchDeck(fetcher: typeof fetch = fetch): Promise<DeckState> {
  const response = await requestDeck(fetcher);
  if (!response.ok) throw new DeckRequestError(`Could not load cards (HTTP ${response.status}).`);
  return parseDeckResponse(await readResponse(response));
}

export async function submitMutation(request: MutationRequest, fetcher: typeof fetch = fetch): Promise<MutationResult> {
  let response: Response;
  try {
    response = await fetcher('/api/cards', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new DeckRequestError('Could not reach the server. The save outcome is unknown; refresh before retrying.', { cause: error });
  }
  const value = await readResponse(response);
  if (!response.ok) {
    throw new DeckRequestError(isRecord(value) && typeof value.error === 'string'
      ? value.error : `Could not save the card (HTTP ${response.status}).`);
  }
  if (!isRecord(value) || value.source !== request.source || typeof value.revision !== 'string' ||
      !Array.isArray(value.cards) || !value.cards.every(isCard) || value.cards.some(card => card.source !== request.source)) {
    throw new DeckRequestError('The server returned an invalid save response. Refresh before retrying.');
  }
  return { source: value.source as string, revision: value.revision, cards: value.cards };
}
