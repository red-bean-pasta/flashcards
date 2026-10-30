import type { DeckState, MutationRequest } from './types.js';

export interface DeckBackend {
  load(signal?: AbortSignal): Promise<DeckState>;
  mutate(request: MutationRequest, snapshot: DeckState): Promise<DeckState>;
}
