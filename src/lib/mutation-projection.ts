import { createOperationProjector, isUnchangedEdit, samePair } from './onedrive/operations.js';
import type { MutationStage, StoredMutation } from './mutation-storage.js';
import type { DeckState } from './types.js';
import { parseBrowserCards } from './browser-cards.js';

/** Apply only the recovered operation to the current practice snapshot. */
export function createRecoveredProjector(parse = parseBrowserCards) {
  const project = createOperationProjector(parse);
  return function projectRecoveredMutation(deck: DeckState, item: StoredMutation, saved: DeckState, startedAt: MutationStage): DeckState {
  const operation = item.operation;
  const originalPresent = operation.original && deck.cards.some(card => card.source === operation.source && samePair(card, operation.original!));
  const shouldProject = startedAt !== 'releasing' && !isUnchangedEdit(operation) && (operation.action === 'add' || originalPresent);
  const revision = saved.revisions[operation.source];
  if (!revision) throw new Error('A completed mutation must have a source revision.');
  return shouldProject ? project(deck, operation, revision, item.sourceWrite?.after) :
    { ...deck, revisions: { ...deck.revisions, [operation.source]: revision } };
  };
}

export const projectRecoveredMutation = createRecoveredProjector();
