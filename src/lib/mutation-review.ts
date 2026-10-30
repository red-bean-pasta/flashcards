import { parseCardRanges } from './card-ranges.js';
import { normalizedPair, samePair, type CardOperation, type Pair } from './onedrive/operations.js';

export type SourceReview = 'satisfied' | 'safe-to-retry' | 'needs-review';

function count(text: string, source: string, pair: Pair): number {
  return parseCardRanges(text, source).filter(range => samePair(range.content, pair)).length;
}

/** A safe-to-retry result still requires a conditional write or equivalent protection. */
export function reviewSource(operation: CardOperation, before: string, current: string, archive?: string): SourceReview {
  if (operation.action === 'add') {
    return current === before ? 'safe-to-retry' : 'needs-review';
  }
  if (!operation.original) throw new Error('Review requires the original card pair.');
  if (operation.action === 'edit' && samePair(operation.original, normalizedPair(operation.replacement))) return 'satisfied';
  const originalBefore = count(before, operation.source, operation.original);
  if (!originalBefore) throw new Error('Review requires a source snapshot containing the original card.');
  const originals = count(current, operation.source, operation.original);
  if (operation.action === 'remove') {
    if (archive === undefined) throw new Error('Removal review requires the archive contents.');
    const archived = count(archive, 'removed.md', operation.original) > 0;
    if (!originals && archived) return 'satisfied';
    return current === before && archived ? 'safe-to-retry' : 'needs-review';
  }
  const replacement = normalizedPair(operation.replacement);
  const replacementsBefore = count(before, operation.source, replacement);
  const replacementsNow = count(current, operation.source, replacement);
  if (!originals && replacementsNow >= replacementsBefore + originalBefore) return 'satisfied';
  return current === before ? 'safe-to-retry' : 'needs-review';
}

/** Establish whether the prepared archive write completed. */
export function reviewArchive(operation: CardOperation, before: string, after: string, current: string): SourceReview {
  if (operation.action !== 'remove' || !operation.original) throw new Error('Archive review requires a removal with an original pair.');
  if (current === after) return 'satisfied';
  return current === before ? 'safe-to-retry' : 'needs-review';
}
