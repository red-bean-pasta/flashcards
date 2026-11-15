import type { DeckState, MutationRequest } from './types.js';
import type { MutationDestination, StoredMutation } from './mutation-storage.js';
import type { SeenIncrement } from './onedrive/operations.js';

export interface PersistentMutationBackend {
  destination: MutationDestination;
  execute(item: StoredMutation, checkpoint: (item: StoredMutation) => Promise<void>, recovered?: boolean): Promise<DeckState>;
  flushSeen?(source: string, increments: ReadonlyArray<SeenIncrement>): Promise<string | null>;
}

export interface DeckBackend {
  load(signal?: AbortSignal): Promise<DeckState>;
  mutate(request: MutationRequest, snapshot: DeckState): Promise<DeckState>;
  persistent?: PersistentMutationBackend;
}
