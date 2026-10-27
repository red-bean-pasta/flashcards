import { CardParseError, parseCardRanges, parseCards } from './parser.js';
import { MutationError } from './mutation-contract.js';
import type { MutationRequest } from '../src/lib/types.js';

function cardMarkdown(question: string, answer: string, eol: string): string {
  const normalize = (text: string) => text.trim().replace(/\r\n?|\n/g, eol);
  const text = `# question${eol}${normalize(question)}${eol}${eol}# answer${eol}${normalize(answer)}${eol}${eol}`;
  try {
    const cards = parseCards(text, 'Card input');
    if (cards.length !== 1 || cards[0].question !== question.trim().replace(/\r\n?/g, '\n') ||
        cards[0].answer !== answer.trim().replace(/\r\n?/g, '\n')) {
      throw new MutationError('Card content cannot contain card markers or standalone --- separators.');
    }
  } catch (error) {
    if (!(error instanceof CardParseError)) throw error;
    throw new MutationError(error.message, 400, { cause: error });
  }
  return text;
}

export function appendEntry(text: string, entry: string, eol: string): string {
  return text + (text && !text.endsWith(eol + eol) ? (text.endsWith(eol) ? eol : eol + eol) : '') + entry;
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

