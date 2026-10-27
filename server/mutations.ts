import path from 'node:path';
import { MutationError, validateMutation, destination } from './mutation-contract.js';
import { buildChange, appendEntry } from './markdown-mutation.js';
import { parseCards } from './parser.js';
import { materialRevision } from './revision.js';
import { atomicWrite, createWriteTransaction, readOptional } from './write-transaction.js';
import type { MutationResult } from '../src/lib/types.js';

function requireRevision(text: string | null, revision: string | null): void {
  if ((text === null ? null : materialRevision(text)) !== revision) {
    throw new MutationError('This file changed since this page loaded. Refresh the browser before saving. Your dialog contents have been kept.', 409);
  }
}

export { MutationError } from './mutation-contract.js';

export function createMutations(directory: string) {
  const transaction = createWriteTransaction(directory);

  async function removeWithArchive(filename: string, before: string, after: string, removed: string): Promise<void> {
    const archive = path.join(directory, 'removed.md');
    const archived = await readOptional(archive);
    const eol = archived?.match(/\r\n|\r|\n/)?.[0] ?? removed.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    const nextArchive = appendEntry(archived ?? '', removed, eol);
    parseCards(nextArchive, 'removed.md');
    await transaction.commit([
      { filename: archive, before: archived, after: nextArchive },
      { filename, before, after },
    ]);
  }

  async function mutate(input: unknown): Promise<MutationResult> {
    const request = validateMutation(input);
    const filename = destination(directory, request.source);
    await transaction.recover();
    const original = await readOptional(filename);
    requireRevision(original, request.revision);
    if (original === null && request.action !== 'add') throw new MutationError('Card file no longer exists.', 409);
    if (original === null && !/^[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*\.md$/u.test(request.source)) {
      throw new MutationError('New filenames must use file_name.md without a folder path.');
    }
    const change = buildChange(original ?? '', request);
    const cards = parseCards(change.text, request.source);
    if (change.removed !== undefined) await removeWithArchive(filename, original!, change.text, change.removed);
    else await atomicWrite(filename, change.text, original);
    return { source: request.source, revision: materialRevision(change.text), cards };
  }

  return { mutate, recover: transaction.recover };
}
