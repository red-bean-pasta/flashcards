import { archiveFilename } from './card-text.js';

export function segmentLabel(segment: string): string {
  return segment
    .replace(/\.md$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\p{L}/gu, letter => letter.toUpperCase());
}

export function sourceLabel(source: string): string {
  const clean = source.replace(/\.md$/i, '').replace(/\/$/, '');
  return clean
    .split('/')
    .filter(Boolean)
    .map(segmentLabel)
    .join(' / ');
}

function newSource(label: string): string {
  const name = label.trim().replace(/\.md$/i, '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  return name ? `${name}.md` : '';
}

export function resolveSource(files: string[], text: string, chosen: string) {
  let match: string | undefined;
  if (!chosen) {
    const label = text.trim().toLowerCase();
    for (const file of files) {
      if (sourceLabel(file).toLowerCase() !== label) continue;
      if (match !== undefined) return { source: '', create: false, error: 'Choose the intended file from the suggestions.' };
      match = file;
    }
  }
  const create = !chosen && match === undefined;
  const source = chosen || match || newSource(text);
  if (!source) return { source: '', create: false, error: 'Enter a file name.' };
  const error = source.toLowerCase() === archiveFilename ? 'removed.md is reserved for archived cards.' : '';
  return { source, create, error };
}
