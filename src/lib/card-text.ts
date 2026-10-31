import { CardParseError, parseCardRanges } from './card-ranges.js';

export class CardInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CardInputError';
  }
}

export function formatEntry(question: string, answer: string, eol: string): string {
  const normalize = (text: string) => text.trim().replace(/\r\n?|\n/g, eol);
  const text = `# question${eol}${normalize(question)}${eol}${eol}# answer${eol}${normalize(answer)}${eol}${eol}`;
  try {
    const entries = parseCardRanges(text, 'Card input');
    if (entries.length !== 1 || entries[0].content.question !== question.trim().replace(/\r\n?/g, '\n') ||
        entries[0].content.answer !== answer.trim().replace(/\r\n?/g, '\n')) {
      throw new CardInputError('Card content cannot contain card markers or standalone --- separators.');
    }
  } catch (error) {
    if (!(error instanceof CardParseError)) throw error;
    throw new CardInputError(error.message, { cause: error });
  }
  return text;
}

export function appendEntry(text: string, entry: string, eol: string): string {
  return text + (text && !text.endsWith(eol + eol) ? (text.endsWith(eol) ? eol : eol + eol) : '') + entry;
}

export const archiveFilename = 'removed.md';

export function isNewSourceName(source: string): boolean {
  return /^[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*\.md$/u.test(source);
}

export function appendArchivedEntries(archive: string, removed: string): string {
  const key = (pair: { question: string; answer: string }) => JSON.stringify([pair.question, pair.answer]);
  const seen = new Set(parseCardRanges(archive, archiveFilename).map(range => key(range.content)));
  const additions: string[] = [];
  for (const range of parseCardRanges(removed, archiveFilename)) {
    const value = key(range.content);
    if (seen.has(value)) continue;
    seen.add(value);
    additions.push(removed.slice(range.start, range.end));
  }
  if (!additions.length) return archive;
  const eol = archive.match(/\r\n|\r|\n/)?.[0] ?? removed.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  return appendEntry(archive, additions.join(''), eol);
}
