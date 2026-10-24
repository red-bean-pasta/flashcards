import { createHash } from 'node:crypto';
import { inspectMarkdown, extractContent } from './markdown-structure.js';
import type { Marker, MarkdownStructure } from './markdown-structure.js';
import { renderMarkdown } from './markdown.js';
import type { Card } from '../src/lib/types.js';

export class CardParseError extends Error {
  constructor(source: string, line: number, message: string) {
    super(`${source}:${line}: ${message}`);
    this.name = 'CardParseError';
  }
}

type CardText = { question: string; answer: string; line: number };

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
  const text = input.replace(/\r\n?/g, '\n');
  const structure = inspectMarkdown(text);
  validatePreamble(text, source, structure);
  const cards: Card[] = [];
  for (let index = 0; index < structure.markers.length; index += 2) {
    cards.push(createCard(extractPair(text, source, structure, index), source, cards.length));
  }
  return cards;
}
