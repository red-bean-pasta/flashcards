import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CardParseError, parseCardRanges } from '../src/lib/card-ranges.js';
import { appendEntry, CardInputError, formatEntry } from '../src/lib/card-text.js';
import { parseBrowserCards } from '../src/lib/browser-cards.js';

test('browser cards preserve content and source lines with transient IDs', () => {
  const text = '---\n\n# question\n**Q**\n\n# answer\n```md\n# question\n```\n';
  const render = (markdown: string) => `rendered:${markdown}`;
  const first = parseBrowserCards(text, 'nested/deck.md', render);
  const second = parseBrowserCards(text, 'nested/deck.md', render);
  assert.equal(first.length, 1);
  assert.deepEqual({ question: first[0].question, answer: first[0].answer, line: first[0].line, source: first[0].source },
    { question: '**Q**', answer: '```md\n# question\n```', line: 3, source: 'nested/deck.md' });
  assert.equal(first[0].questionHtml, 'rendered:**Q**');
  assert.equal(first[0].answerHtml, 'rendered:```md\n# question\n```');
  assert.match(first[0].id, /^[0-9a-f-]{36}$/);
  assert.notEqual(first[0].id, second[0].id);
});

test('shared entry formatting retains requested line endings and fenced markers', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const question = '  Q\r\n\r\n```md\r\n# answer\r\n```  ';
    const entry = formatEntry(question, ' **A** ', eol);
    assert.equal(entry, ['# question', 'Q', '', '```md', '# answer', '```', '', '# answer', '**A**', '', ''].join(eol));
    const ranges = parseCardRanges(entry, 'deck.md');
    assert.equal(ranges[0].content.answer, '**A**');
    assert.equal(appendEntry('', entry, eol), entry);
    assert.equal(appendEntry('existing', entry, eol), `existing${eol}${eol}${entry}`);
    assert.equal(appendEntry(`existing${eol}`, entry, eol), `existing${eol}${eol}${entry}`);
    assert.equal(appendEntry(`existing${eol}${eol}`, entry, eol), `existing${eol}${eol}${entry}`);
  }
});

test('entry validation rejects lossy content and retains the parse failure cause', () => {
  assert.throws(() => formatEntry('', 'A', '\n'), error =>
    error instanceof CardInputError && error.cause instanceof CardParseError &&
    error.message === 'Card input:1: Question is empty.');
  for (const question of ['Q\n\n---\n\nRest', 'Q\n\n# answer\nInjected']) {
    assert.throws(() => formatEntry(question, 'A', '\n'), CardInputError);
  }
  assert.throws(() => parseBrowserCards('# answer\nA', 'bad.md', value => value), CardParseError);
});
