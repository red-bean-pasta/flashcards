import { inspectMarkdown, createContentReader } from './markdown-structure.js';
import type { Marker, Span } from './markdown-structure.js';

export class CardParseError extends Error {
  constructor(source: string, line: number, message: string) {
    super(`${source}:${line}: ${message}`);
    this.name = 'CardParseError';
  }
}

export type CardText = { question: string; answer: string; seen: number; line: number };
export type CardRange = { content: CardText; start: number; end: number };

function requireAnswer(question: Marker, answer: Marker | undefined, source: string): Marker {
  if (question.kind === 'answer') {
    throw new CardParseError(source, question.line, 'Answer has no preceding question.');
  }
  if (question.kind === 'seen') {
    throw new CardParseError(source, question.line, 'Seen count must follow # answer.');
  }
  if (!answer || answer.kind !== 'answer') {
    throw new CardParseError(source, question.line, 'Question must be followed by # answer.');
  }
  return answer;
}

function parseSeenCount(raw: string, source: string, line: number): number {
  if (!raw) {
    throw new CardParseError(source, line, 'Seen count is empty.');
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
    throw new CardParseError(source, line, 'Seen count must be a number.');
  }
  const truncated = Math.trunc(Number(raw));
  if (!Number.isSafeInteger(truncated)) {
    throw new CardParseError(source, line, 'Seen count must be a finite integer.');
  }
  return truncated <= 0 ? 0 : truncated;
}

function validateSeenPlacement(text: string, ignored: Span[], answerEnd: number, seenMarker: Marker, end: number, source: string): void {
  if (ignored.some(span => span.start >= answerEnd && span.end <= seenMarker.start)) {
    throw new CardParseError(source, seenMarker.line, 'Seen count must appear before --- separator.');
  }
  for (const span of ignored) {
    if (span.start >= seenMarker.end && span.end <= end && !text.slice(seenMarker.end, span.start).trim()) {
      throw new CardParseError(source, seenMarker.line, 'Seen count must appear before --- separator.');
    }
  }
}

export function parseCardRanges(text: string, source: string): CardRange[] {
  const { markers, ignored } = inspectMarkdown(text);
  const readContent = createContentReader(text, ignored);
  if (readContent(0, markers[0]?.start ?? text.length)) {
    throw new CardParseError(source, 1, 'Expected # question before card content.');
  }
  const entries: CardRange[] = [];
  let index = 0;
  while (index < markers.length) {
    const question = markers[index];
    const answer = requireAnswer(question, markers[index + 1], source);
    const seenMarker = markers[index + 2]?.kind === 'seen' ? markers[index + 2] : undefined;
    const nextMarker = markers[index + (seenMarker ? 3 : 2)];
    const end = nextMarker?.start ?? text.length;
    const questionText = readContent(question.end, answer.start);
    const answerEnd = seenMarker ? seenMarker.start : end;
    const answerText = readContent(answer.end, answerEnd);
    if (!questionText) throw new CardParseError(source, question.line, 'Question is empty.');
    if (!answerText) throw new CardParseError(source, answer.line, 'Answer is empty.');
    if (seenMarker) validateSeenPlacement(text, ignored, answer.end, seenMarker, end, source);
    const seen = seenMarker ? parseSeenCount(readContent(seenMarker.end, end), source, seenMarker.line) : 0;
    entries.push({
      content: {
        question: questionText.replace(/\r\n?/g, '\n'),
        answer: answerText.replace(/\r\n?/g, '\n'),
        seen,
        line: question.line,
      },
      start: question.start,
      end,
    });
    index += seenMarker ? 3 : 2;
  }
  return entries;
}
