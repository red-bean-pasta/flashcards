/** Formats the accessible and expanded encounter-count label for a flashcard. */
export function formatSeenLabel(seen: number): string {
  if (!Number.isInteger(seen) || seen < 0) {
    throw new RangeError(`Expected non-negative integer seen count, got ${seen}`);
  }
  return seen === 1 ? 'Seen 1 time' : `Seen ${seen} times`;
}
