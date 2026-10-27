export function sourceLabel(source: string): string {
  return source.replace(/\.md$/i, '').split('/').map(part =>
    part.replace(/[_-]+/g, ' ').replace(/\b\p{L}/gu, letter => letter.toUpperCase())).join(' / ');
}

function newSource(label: string): string {
  const name = label.trim().replace(/\.md$/i, '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  return name ? `${name}.md` : '';
}

export function resolveSource(files: string[], text: string, chosen: string) {
  const matching = files.filter(source => sourceLabel(source).toLowerCase() === text.trim().toLowerCase());
  if (!chosen && matching.length > 1) {
    return { source: '', create: false, error: 'Choose the intended file from the suggestions.' };
  }
  const create = !chosen && matching.length === 0;
  const source = chosen || matching[0] || newSource(text);
  if (!source) return { source: '', create: false, error: 'Enter a file name.' };
  const error = source.toLowerCase() === 'removed.md' ? 'removed.md is reserved for archived cards.' : '';
  return { source, create, error };
}
