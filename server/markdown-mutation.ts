import { parseCardRanges } from './parser.js';
import { MutationError } from './mutation-contract.js';
import type { MutationRequest } from '../src/lib/types.js';
import { CardInputError, formatEntry, appendEntry } from '../src/lib/card-text.js';
export { appendEntry } from '../src/lib/card-text.js';

function cardMarkdown(question: string, answer: string, eol: string): string {
  try {
    return formatEntry(question, answer, eol);
  } catch (error) {
    if (!(error instanceof CardInputError)) throw error;
    throw new MutationError(error.message, 400, { cause: error });
  }
}

export function buildChange(text: string, request: MutationRequest): { text: string; removed?: string } {
  const ranges = parseCardRanges(text, request.source);
  const eol = text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  if (request.action === 'add') return { text: appendEntry(text, cardMarkdown(request.question, request.answer, eol), eol) };
  const range = ranges[request.index];
  if (!range) throw new MutationError('This card position no longer exists. Refresh the browser.', 409);
  const replacement = request.action === 'edit' ? cardMarkdown(request.question, request.answer, eol) : '';
  return {
    text: text.slice(0, range.start) + replacement + text.slice(range.end),
    ...(request.action === 'remove' ? { removed: text.slice(range.start, range.end) } : {}),
  };
}

