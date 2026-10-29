import { applyMutation } from './card-mutations.js';
import { fetchDeck, submitMutation } from './deck-client.js';
import type { DeckState, MutationRequest } from './types.js';

export interface DeckBackend {
  load(signal?: AbortSignal): Promise<DeckState>;
  mutate(request: MutationRequest, snapshot: DeckState): Promise<DeckState>;
}

export const localBackend: DeckBackend = {
  load: () => fetchDeck(),
  async mutate(request, snapshot) { return applyMutation(snapshot, request, await submitMutation(request)); },
};
