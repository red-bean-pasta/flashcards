import type { DeckState, MutationRequest } from './types.js';
import type { MutationDestination, StoredMutation } from './mutation-storage.js';

export interface PersistentMutationBackend {
  destination: MutationDestination;
  execute(item: StoredMutation, checkpoint: (item: StoredMutation) => Promise<void>, recovered?: boolean): Promise<DeckState>;
}

export interface DeckBackend {
  load(signal?: AbortSignal): Promise<DeckState>;
  mutate(request: MutationRequest, snapshot: DeckState): Promise<DeckState>;
  persistent?: PersistentMutationBackend;
}
