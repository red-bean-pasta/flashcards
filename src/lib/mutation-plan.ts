import { appendArchivedEntries } from './card-text.js';
import { DeckRequestError } from './deck-client.js';
import type { StoredMutation } from './mutation-storage.js';
import { planContent } from './onedrive/operations.js';

/** Do not publish persisted bytes unless they still describe the recorded intent. */
export function validateMutationPlan(item: StoredMutation): void {
  if (!item.sourceWrite) return;
  const expected = planContent(item.sourceWrite.before ?? '', item.operation);
  if (expected.text !== item.sourceWrite.after) throw new DeckRequestError('The saved source plan does not match the requested change. Review it before continuing.');
  if (item.operation.action === 'remove') {
    if (!item.archiveWrite || item.archiveWrite.after !== appendArchivedEntries(item.archiveWrite.before ?? '', expected.removed)) {
      throw new DeckRequestError('The saved archive plan does not match the requested removal. Review it before continuing.');
    }
  } else if (item.archiveWrite) throw new DeckRequestError('The saved change has an unexpected archive plan. Review it before continuing.');
}
