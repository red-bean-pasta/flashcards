import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CardParseError, parseCardRanges } from '../src/lib/card-ranges.js';
import { appendEntry, CardInputError, formatEntry } from '../src/lib/card-text.js';
import { parseBrowserCards, renderBrowserMarkdown, safeHtml, sanitizeHtml } from '../src/lib/browser-cards.js';

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

test('renderBrowserMarkdown fails loudly without a browser Document sanitizer environment', () => {
  assert.throws(() => renderBrowserMarkdown('# Hello'), /HTML sanitization requires a browser Document environment/);
});

test('sanitizeHtml and safeHtml filter unsafe URLs and wrap tables idempotently via setHTML', () => {
  class MockElement {
    tagName: string;
    attributes = new Map<string, string>();
    children: MockElement[] = [];
    parentElement: MockElement | null = null;
    ownerDocument: unknown;
    private rawText = '';

    constructor(tagName: string, ownerDocument: unknown, attrs: Record<string, string> = {}, rawText = '') {
      this.tagName = tagName.toUpperCase();
      this.ownerDocument = ownerDocument;
      this.rawText = rawText;
      for (const [k, v] of Object.entries(attrs)) {
        this.attributes.set(k, v);
      }
    }

    get className(): string {
      return this.attributes.get('class') ?? '';
    }

    set className(value: string) {
      this.attributes.set('class', value);
    }

    get childElementCount(): number {
      return this.children.length;
    }

    getAttribute(name: string): string | null {
      return this.attributes.get(name) ?? null;
    }

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }

    removeAttribute(name: string): void {
      this.attributes.delete(name);
    }

    append(...nodes: MockElement[]): void {
      for (const node of nodes) {
        node.parentElement = this;
        this.children.push(node);
      }
    }

    replaceWith(replacement: MockElement): void {
      if (!this.parentElement) return;
      const index = this.parentElement.children.indexOf(this);
      if (index !== -1) {
        replacement.parentElement = this.parentElement;
        this.parentElement.children[index] = replacement;
        this.parentElement = null;
      }
    }

    setHTML(html: string, options: { sanitizer: { attributes: string[]; elements: string[] } }): void {
      assert.equal(options.sanitizer.attributes.includes('tabindex'), false);
      assert.equal(options.sanitizer.elements.includes('table'), true);
      this.children = [];
      const safeLink = new MockElement('a', this.ownerDocument, { href: 'https://example.com' }, 'ok');
      const unsafeLink = new MockElement('a', this.ownerDocument, { href: 'javascript:alert(1)' }, 'bad');
      const unsafeImg = new MockElement('img', this.ownerDocument, { src: 'data:image/png;base64,abc', alt: 'x' });
      const safeImg = new MockElement('img', this.ownerDocument, { src: 'https://example.com/pic.png', alt: 'ok' });
      const table = new MockElement('table', this.ownerDocument, {}, '<tr><th>H</th></tr>');
      if (html.includes('table-wrapper')) {
        const preWrapped = new MockElement('div', this.ownerDocument, { class: 'table-wrapper' });
        preWrapped.append(table);
        this.append(safeLink, unsafeLink, unsafeImg, safeImg, preWrapped);
      } else {
        this.append(safeLink, unsafeLink, unsafeImg, safeImg, table);
      }
    }

    querySelectorAll(selector: string): MockElement[] {
      const results: MockElement[] = [];
      const selectors = selector.split(/,\s*/);
      const matches = (node: MockElement) => selectors.some(item => {
        if (item === '[href]') return node.attributes.has('href');
        if (item === '[src]') return node.attributes.has('src');
        return node.tagName === item.toUpperCase();
      });
      const visit = (node: MockElement) => {
        for (const child of node.children) {
          if (matches(child)) results.push(child);
          visit(child);
        }
      };
      visit(this);
      return results;
    }

    get innerHTML(): string {
      const tag = this.tagName.toLowerCase();
      const attrs = [...this.attributes.entries()].map(([k, v]) => ` ${k}="${v}"`).join('');
      if (this.children.length === 0) return tag === 'div' && !attrs ? this.rawText : `<${tag}${attrs}>${this.rawText}</${tag}>`;
      const body = this.children.map(child => child.innerHTML).join('');
      return tag === 'div' && !attrs ? body : `<${tag}${attrs}>${body}</${tag}>`;
    }
  }

  const previousElement = globalThis.Element;
  const previousDocument = globalThis.document;
  const mockDoc = {
    createElement(tag: string) {
      return new MockElement(tag, mockDoc);
    },
  };

  globalThis.Element = MockElement as unknown as typeof Element;
  globalThis.document = mockDoc as unknown as Document;
  try {
    const cleaned = sanitizeHtml('<a href="javascript:alert(1)"></a><table></table>');
    assert.match(cleaned, /href="https:\/\/example\.com"/);
    assert.doesNotMatch(cleaned, /javascript:alert/);
    assert.doesNotMatch(cleaned, /data:image/);
    assert.match(cleaned, /src="https:\/\/example\.com\/pic\.png"/);
    assert.equal((cleaned.match(/class="table-wrapper"/g) ?? []).length, 1);
    assert.match(cleaned, /<div class="table-wrapper" tabindex="0" role="region" aria-label="Table"><table>/);

    const host = mockDoc.createElement('div') as unknown as HTMLElement & MockElement;
    const action = safeHtml(host, cleaned);
    assert.equal((host.innerHTML.match(/class="table-wrapper"/g) ?? []).length, 1);
    assert.match(host.innerHTML, /tabindex="0" role="region" aria-label="Table"/);
    action.update('<a href="https://example.com"></a><table></table>');
    assert.equal((host.innerHTML.match(/class="table-wrapper"/g) ?? []).length, 1);
  } finally {
    globalThis.Element = previousElement;
    globalThis.document = previousDocument;
  }
});
