import { DeckRequestError, fetchDeck } from './deck-client';
import type { DeckState } from './types';

type LoaderCallbacks = {
  onDeck(deck: DeckState): void;
  onError(message: string): void;
  onLoading(loading: boolean): void;
};

export function createDeckLoader(callbacks: LoaderCallbacks, request = fetchDeck) {
  let revision = 0;
  let closed = false;

  async function refresh(): Promise<void> {
    if (closed) throw new Error('Cannot refresh a closed deck loader.');
    const requestRevision = ++revision;
    let next: DeckState;
    try {
      next = await request();
    } catch (error) {
      if (!(error instanceof DeckRequestError)) throw error;
      if (closed || requestRevision !== revision) return;
      callbacks.onError(error.message);
      callbacks.onLoading(false);
      return;
    }
    if (closed || requestRevision !== revision) return;
    // Keep application callbacks outside the recoverable transport boundary.
    callbacks.onDeck(next);
    callbacks.onError('');
    callbacks.onLoading(false);
  }

  function close(): void {
    closed = true;
    revision++;
  }

  return { refresh, close };
}
