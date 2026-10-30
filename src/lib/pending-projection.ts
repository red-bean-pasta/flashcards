import { createOperationProjector, isUnchangedEdit, samePair } from './onedrive/operations.js';
import type { StoredMutation } from './mutation-storage.js';
import type { DeckState } from './types.js';

/** Show accepted edits and removals immediately while their saved snapshot remains authoritative. */
export function createPendingProjector(parse?: Parameters<typeof createOperationProjector>[0]) {
  const project = createOperationProjector(parse);
  return (deck: DeckState, items: StoredMutation[], matched: string[], completedId?: string): DeckState => {
    let visible = deck;
    for (const item of items) {
      const operation = item.operation;
      if (item.id === completedId || !matched.includes(item.id) || operation.action === 'add' || isUnchangedEdit(operation)) continue;
      if (!operation.original || !visible.cards.some(card => card.source === operation.source && samePair(card, operation.original!))) continue;
      visible = project(visible, operation, visible.revisions[operation.source]);
    }
    return visible;
  };
}

export const projectPendingMutations = createPendingProjector();
