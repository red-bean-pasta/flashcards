import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CardParseError, parseCardRanges } from '../src/lib/card-ranges.js';
import { parseBrowserCards } from '../src/lib/browser-cards.js';
const parseCards = (text: string, source: string) => parseBrowserCards(text, source, value => value);

test('plain ranges preserve raw spans and normalize card text across line endings', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const prefix = `---${eol}${eol}`;
    const first = ['# question', 'Q', '', '```md', '# answer', '```', '', '# answer', '**A**', '', ''].join(eol);
    const second = ['# question', 'Second', '# answer', 'Answer'].join(eol);
    const text = prefix + first + second;
    const ranges = parseCardRanges(text, 'deck.md');
    assert.deepEqual(ranges, [
      { content: { question: 'Q\n\n```md\n# answer\n```', answer: '**A**', seen: 0, line: 3 }, start: prefix.length, end: prefix.length + first.length },
      { content: { question: 'Second', answer: 'Answer', seen: 0, line: 13 }, start: prefix.length + first.length, end: text.length },
    ]);
    assert.equal(text.slice(ranges[0].start, ranges[0].end), first);
    const cards = parseCards(text, 'deck.md');
    assert.equal(cards[0].question, ranges[0].content.question);
    assert.equal(cards[0].answerHtml, '**A**');
    assert.equal(cards[0].source, 'deck.md');
    assert.equal(cards[0].line, 3);
  }
});

test('range validation and rendered parsing retain source and line diagnostics', () => {
  const cases = [
    ['Unexpected content', 'deck.md:1: Expected # question before card content.'],
    ['# answer\nA', 'deck.md:1: Answer has no preceding question.'],
    ['# question\nQ', 'deck.md:1: Question must be followed by # answer.'],
    ['# question\n\n# answer\nA', 'deck.md:1: Question is empty.'],
    ['# question\nQ\n# answer', 'deck.md:3: Answer is empty.'],
  ];
  for (const [text, message] of cases) {
    for (const parse of [parseCardRanges, parseCards]) {
      assert.throws(() => parse(text, 'deck.md'), error => error instanceof CardParseError && error.message === message);
    }
  }
});

test('optional # seen section normalizes valid numbers and rejects malformed or misplaced markers', () => {
  const validCases = [
    ['# question\nQ\n# answer\nA', 0],
    ['# question\nQ\n# answer\nA\n# seen\n0', 0],
    ['# question\nQ\n# answer\nA\n# seen\n7', 7],
    ['# question\nQ\n# answer\nA\n# seen\n-5', 0],
    ['# question\nQ\n# answer\nA\n# seen\n-0.5', 0],
    ['# question\nQ\n# answer\nA\n# seen\n1.5', 1],
    ['# question\nQ\n# answer\nA\n# seen\n3.9', 3],
    ['# question\nQ\n# answer\nA\n# seen\n4\n\n---\n\n# question\nQ2\n# answer\nA2', 4],
  ] as const;

  for (const [text, expectedSeen] of validCases) {
    const ranges = parseCardRanges(text, 'deck.md');
    const cards = parseCards(text, 'deck.md');
    assert.equal(ranges[0].content.seen, expectedSeen);
    assert.equal(Object.is(ranges[0].content.seen, -0), false);
    assert.equal(cards[0].seen, expectedSeen);
  }

  const invalidCases = [
    ['# question\nQ\n# answer\nA\n# seen\n', 'deck.md:5: Seen count is empty.'],
    ['# question\nQ\n# answer\nA\n# seen\nfive', 'deck.md:5: Seen count must be a number.'],
    ['# question\nQ\n# answer\nA\n# seen\n1e500', 'deck.md:5: Seen count must be a number.'],
    ['# question\nQ\n# answer\nA\n# seen\n99999999999999999999', 'deck.md:5: Seen count must be a finite integer.'],
    ['# seen\n1\n# question\nQ\n# answer\nA', 'deck.md:1: Seen count must follow # answer.'],
    ['# question\nQ\n# seen\n1\n# answer\nA', 'deck.md:1: Question must be followed by # answer.'],
    ['# question\nQ\n# answer\nA\n# seen\n1\n# seen\n2', 'deck.md:7: Seen count must follow # answer.'],
    ['# question\nQ\n# answer\nA\n\n---\n\n# seen\n1', 'deck.md:8: Seen count must appear before --- separator.'],
    ['# question\nQ\n# answer\nA\n# seen\n\n---\n1', 'deck.md:5: Seen count must appear before --- separator.'],
  ] as const;

  for (const [text, message] of invalidCases) {
    for (const parse of [parseCardRanges, parseCards]) {
      assert.throws(() => parse(text, 'deck.md'), error => error instanceof CardParseError && error.message === message);
    }
  }
});
