import { inspectMarkdown, extractContent } from './markdown-structure.js';
import type { Marker, MarkdownStructure } from './markdown-structure.js';

export class CardParseError extends Error {
  constructor(source: string, line: number, message: string) {
    super(`${source}:${line}: ${message}`);
    this.name = 'CardParseError';
  }
}

export type CardText = { question: string; answer: string; line: number };
export type CardRange = { content: CardText; start: number; end: number };

function validatePreamble(text: string, source: string, structure: MarkdownStructure): void {
  if (extractContent(text, 0, structure.markers[0]?.start ?? text.length, structure.ignored)) {
    throw new CardParseError(source, 1, 'Expected # question before card content.');
  }
}

function requireAnswer(question: Marker, answer: Marker | undefined, source: string): Marker {
  if (question.kind !== 'question') {
    throw new CardParseError(source, question.line, 'Answer has no preceding question.');
  }
  if (!answer || answer.kind !== 'answer') {
    throw new CardParseError(source, question.line, 'Question must be followed by # answer.');
  }
  return answer;
}

function extractPair(text: string, source: string, structure: MarkdownStructure, index: number): CardText {
  const question = structure.markers[index];
  const answer = requireAnswer(question, structure.markers[index + 1], source);
  const questionText = extractContent(text, question.end, answer.start, structure.ignored);
  const answerText = extractContent(text, answer.end, structure.markers[index + 2]?.start ?? text.length, structure.ignored);
  if (!questionText) throw new CardParseError(source, question.line, 'Question is empty.');
  if (!answerText) throw new CardParseError(source, answer.line, 'Answer is empty.');
  return { question: questionText, answer: answerText, line: question.line };
}

export function parseCardRanges(text: string, source: string): CardRange[] {
  const structure = inspectMarkdown(text);
  validatePreamble(text, source, structure);
  const entries: CardRange[] = [];
  for (let index = 0; index < structure.markers.length; index += 2) {
    const content = extractPair(text, source, structure, index);
    content.question = content.question.replace(/\r\n?/g, '\n');
    content.answer = content.answer.replace(/\r\n?/g, '\n');
    entries.push({
      content,
      start: structure.markers[index].start,
      end: structure.markers[index + 2]?.start ?? text.length,
    });
  }
  return entries;
}
