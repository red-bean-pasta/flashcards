import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const filesystemCodes = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EIO', 'EBUSY',
  'EEXIST', 'EMFILE', 'ENFILE', 'ESTALE', 'ELOOP', 'ENAMETOOLONG', 'ENOSPC',
]);

export function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error &&
    typeof error.code === 'string' && filesystemCodes.has(error.code);
}

export class MaterialReadError extends Error {
  constructor(source: string, cause: NodeJS.ErrnoException) {
    super(`${source}: ${cause.message}`, { cause });
    this.name = 'MaterialReadError';
  }
}

export async function scanMarkdown(directory: string, ancestors: ReadonlySet<string> = new Set()): Promise<string[]> {
  const resolved = await realpath(directory);
  // Reject ancestor cycles; distinct logical aliases remain distinct materials.
  if (ancestors.has(resolved)) {
    const error: NodeJS.ErrnoException = new Error(`Recursive directory link: ${directory} resolves to ancestor ${resolved}`);
    error.code = 'ELOOP';
    error.path = directory;
    throw error;
  }
  const branch = new Set([...ancestors, resolved]);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filename = path.join(directory, entry.name);
    const target = entry.isSymbolicLink() ? await stat(filename) : entry;
    if (target.isDirectory()) return scanMarkdown(filename, branch);
    return target.isFile() && entry.name.toLowerCase().endsWith('.md') ? [filename] : [];
  }));
  return nested.flat().sort();
}

export async function readMaterial(filename: string, source: string): Promise<string> {
  try {
    return await readFile(filename, 'utf8');
  } catch (error) {
    if (!isFilesystemError(error)) throw error;
    throw new MaterialReadError(source, error);
  }
}
