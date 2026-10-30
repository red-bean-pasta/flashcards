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
      { content: { question: 'Q\n\n```md\n# answer\n```', answer: '**A**', line: 3 }, start: prefix.length, end: prefix.length + first.length },
      { content: { question: 'Second', answer: 'Answer', line: 13 }, start: prefix.length + first.length, end: text.length },
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
