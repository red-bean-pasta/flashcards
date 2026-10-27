import { readFile, realpath, rename, unlink, writeFile, stat, lstat, link } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MutationError } from './mutation-contract.js';
import { hasFilesystemCode } from './filesystem.js';

export type FileChange = { filename: string; before: string | null; after: string };

export async function readOptional(filename: string): Promise<string | null> {
  try { return await readFile(filename, 'utf8'); }
  catch (error) {
    if (!hasFilesystemCode(error, 'ENOENT')) throw error;
    return null;
  }
}

async function writeTarget(filename: string): Promise<string> {
  try { return await realpath(filename); }
  catch (error) {
    if (!hasFilesystemCode(error, 'ENOENT')) throw error;
    // A dangling link is an external filesystem error, not an absent destination.
    const entry = await lstat(filename).catch(failure => { if (hasFilesystemCode(failure, 'ENOENT')) return null; throw failure; });
    if (entry?.isSymbolicLink()) throw error;
    return path.join(await realpath(path.dirname(filename)), path.basename(filename));
  }
}

export async function atomicWrite(filename: string, text: string, expected: string | null): Promise<void> {
  const target = await writeTarget(filename);
  if (await readOptional(target) !== expected) throw new MutationError('The destination changed during saving. Refresh before retrying.', 409);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let mode = 0o600;
  try { mode = (await stat(target)).mode; }
  catch (error) {
    if (!hasFilesystemCode(error, 'ENOENT')) throw error;
  }
  await writeFile(temporary, text, { flag: 'wx', mode });
  try {
    // Exclusive creation avoids replacing a file created after the revision check.
    if (expected === null) await link(temporary, target);
    else await rename(temporary, target);
  }
  finally { await unlink(temporary).catch(error => { if (!hasFilesystemCode(error, 'ENOENT')) throw error; }); }
}

function parseJournal(text: string): FileChange[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length !== 2 || !value.every(item =>
    typeof item === 'object' && item !== null && typeof item.filename === 'string' &&
    (item.before === null || typeof item.before === 'string') && typeof item.after === 'string')) {
    throw new Error('Removal journal contract violated: invalid transaction.');
  }
  return value;
}

export function createWriteTransaction(directory: string) {
  const journal = path.join(directory, '.flashcards-removal.json');

  async function recover(): Promise<void> {
    const text = await readOptional(journal);
    if (text === null) return;
    const changes = parseJournal(text);
    for (const change of changes) {
      const actual = await readOptional(change.filename);
      if (actual !== change.before && actual !== change.after) {
        throw new Error(`Removal recovery conflict: ${change.filename} changed. Restore it from ${journal} before continuing.`);
      }
    }
    for (const change of changes) {
      if (await readOptional(change.filename) !== change.after) await atomicWrite(change.filename, change.after, change.before);
    }
    await unlink(journal);
  }

  async function commit(changes: FileChange[]): Promise<void> {
    if (changes.length !== 2) throw new Error('Removal transaction requires archive and source changes.');
    // Resolve links now so recovery never replaces the link itself.
    const resolved = await Promise.all(changes.map(async change => ({ ...change, filename: await writeTarget(change.filename) })));
    if (new Set(resolved.map(change => change.filename)).size !== resolved.length) {
      throw new MutationError('The archive and source resolve to the same file. Fix the removed.md link before removing cards.', 409);
    }
    await writeFile(journal, JSON.stringify(resolved), { flag: 'wx', mode: 0o600 });
    await recover();
  }

  return { recover, commit };
}
