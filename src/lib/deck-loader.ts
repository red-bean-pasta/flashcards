import { DeckRequestError } from './deck-client';
import type { DeckState } from './types';

export const loadTimeoutMessage = 'Loading took longer than one minute. Choose a smaller folder or retry.';

type LoaderCallbacks = {
  onDeck(deck: DeckState): void;
  onError(message: string): void;
  onLoading(loading: boolean): void;
};

export function createDeckLoader(callbacks: LoaderCallbacks, request: (signal: AbortSignal) => Promise<DeckState>, timeoutMs = 60_000) {
  let revision = 0;
  let closed = false;
  let controller: AbortController | undefined;

  async function refresh(): Promise<void> {
    if (closed) throw new Error('Cannot refresh a closed deck loader.');
    const requestRevision = ++revision;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    callbacks.onLoading(true);
    let next: DeckState;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      next = await Promise.race([
        request(current.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          current.abort();
          reject(new DeckRequestError(loadTimeoutMessage));
        }, timeoutMs); }),
      ]);
    } catch (error) {
      if (closed || requestRevision !== revision) return;
      if (!(error instanceof DeckRequestError)) throw error;
      callbacks.onError(error.message);
      callbacks.onLoading(false);
      return;
    } finally { clearTimeout(timer); }
    if (closed || requestRevision !== revision) return;
    // Keep application callbacks outside the recoverable transport boundary.
    callbacks.onDeck(next);
    callbacks.onError('');
    callbacks.onLoading(false);
  }

  function close(): void {
    closed = true;
    revision++;
    controller?.abort();
  }

  return { refresh, close };
}
