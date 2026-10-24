import type { Card, DeckState } from './types';

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

function isCard(value: unknown): value is Card {
  if (!isRecord(value)) return false;
  return ['id', 'source', 'question', 'answer', 'questionHtml', 'answerHtml']
    .every(key => typeof value[key] === 'string') &&
    Number.isInteger(value.line) && (value.line as number) > 0;
}

function parseDeckResponse(value: unknown): DeckState {
  if (!isRecord(value) || !Array.isArray(value.cards) || !value.cards.every(isCard) ||
      !isStringArray(value.files) || !isStringArray(value.errors) || typeof value.updatedAt !== 'string') {
    throw new DeckRequestError('The server returned an invalid deck response.');
  }
  if (value.errors.length && value.cards.length) {
    throw new DeckRequestError('The server returned cards alongside collection errors.');
  }
  const ids = value.cards.map(card => card.id);
  if (new Set(ids).size !== ids.length) {
    throw new DeckRequestError('The server returned duplicate card IDs.');
  }
  return { cards: value.cards, files: value.files, errors: value.errors, updatedAt: value.updatedAt };
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
