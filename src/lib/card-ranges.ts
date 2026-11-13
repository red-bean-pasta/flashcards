import { inspectMarkdown, createContentReader } from './markdown-structure.js';
import type { Marker } from './markdown-structure.js';

export class CardParseError extends Error {
  constructor(source: string, line: number, message: string) {
    super(`${source}:${line}: ${message}`);
    this.name = 'CardParseError';
  }
}

export type CardText = { question: string; answer: string; line: number };
export type CardRange = { content: CardText; start: number; end: number };

function requireAnswer(question: Marker, answer: Marker | undefined, source: string): Marker {
  if (question.kind !== 'question') {
    throw new CardParseError(source, question.line, 'Answer has no preceding question.');
  }
  if (!answer || answer.kind !== 'answer') {
    throw new CardParseError(source, question.line, 'Question must be followed by # answer.');
  }
  return answer;
}

export function parseCardRanges(text: string, source: string): CardRange[] {
  const { markers, ignored } = inspectMarkdown(text);
  const readContent = createContentReader(text, ignored);
  if (readContent(0, markers[0]?.start ?? text.length)) {
    throw new CardParseError(source, 1, 'Expected # question before card content.');
  }
  const entries: CardRange[] = [];
  for (let index = 0; index < markers.length; index += 2) {
    const question = markers[index];
    const answer = requireAnswer(question, markers[index + 1], source);
    const end = markers[index + 2]?.start ?? text.length;
    const questionText = readContent(question.end, answer.start);
    const answerText = readContent(answer.end, end);
    if (!questionText) throw new CardParseError(source, question.line, 'Question is empty.');
    if (!answerText) throw new CardParseError(source, answer.line, 'Answer is empty.');
    entries.push({
      content: { question: questionText.replace(/\r\n?/g, '\n'), answer: answerText.replace(/\r\n?/g, '\n'), line: question.line },
      start: question.start,
      end,
    });
  }
  return entries;
}
