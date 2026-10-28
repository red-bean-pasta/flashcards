import { createHash } from 'node:crypto';
import { parseCardRanges } from '../src/lib/card-ranges.js';
import type { CardText } from '../src/lib/card-ranges.js';
import { renderMarkdown } from './markdown.js';
import type { Card } from '../src/lib/types.js';

export { CardParseError, parseCardRanges } from '../src/lib/card-ranges.js';
export type { CardRange } from '../src/lib/card-ranges.js';

function createCard(content: CardText, source: string, index: number): Card {
  const id = createHash('sha256')
    .update(`${source}\0${content.question}\0${content.answer}\0${index}`)
    .digest('hex').slice(0, 20);
  return {
    ...content, id, source,
    questionHtml: renderMarkdown(content.question),
    answerHtml: renderMarkdown(content.answer),
  };
}

export function parseCards(input: string, source: string): Card[] {
  return parseCardRanges(input, source).map((entry, index) => createCard(entry.content, source, index));
}
