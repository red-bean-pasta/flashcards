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
