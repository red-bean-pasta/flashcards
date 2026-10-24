import { DeckRequestError, fetchDeck } from './deck-client';
import type { DeckState } from './types';

type DeckEvents = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  close(): void;
};
type SyncCallbacks = {
  onDeck(deck: DeckState): void;
  onConnection(status: string): void;
  onError(message: string): void;
  onLoading(loading: boolean): void;
};

export function createDeckSync(events: DeckEvents, callbacks: SyncCallbacks, request = fetchDeck) {
  let revision = 0;
  let closed = false;

  async function refresh(): Promise<void> {
    if (closed) throw new Error('Cannot refresh a closed deck synchronization session.');
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

  const handleOpen = () => callbacks.onConnection('Live');
  const handleError = () => callbacks.onConnection('Reconnecting');
  // Unexpected failures remain unhandled rejections with their original stack/cause.
  const handleDeck = () => { void refresh(); };

  function close(): void {
    closed = true;
    revision++;
    events.removeEventListener('open', handleOpen);
    events.removeEventListener('error', handleError);
    events.removeEventListener('deck', handleDeck);
    events.close();
  }

  events.addEventListener('open', handleOpen);
  events.addEventListener('error', handleError);
  events.addEventListener('deck', handleDeck);
  return { refresh, close };
}
