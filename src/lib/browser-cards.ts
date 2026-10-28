import createDOMPurify from 'dompurify';
import { marked } from 'marked';
import { parseCardRanges } from './card-ranges.js';
import type { Card } from './types.js';

const safeTags = [
  'address', 'article', 'aside', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hgroup', 'main', 'nav', 'section', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'hr', 'li', 'menu', 'ol', 'p', 'pre', 'ul', 'a', 'abbr', 'b', 'bdi', 'bdo',
  'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby',
  's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
  'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'img', 'del',
];

export function renderBrowserMarkdown(markdown: string): string {
  const sanitizer = createDOMPurify(window);
  sanitizer.addHook('uponSanitizeAttribute', (_node, attribute) => {
    if (attribute.attrName === 'href') {
      attribute.keepAttr = /^(?:https?:\/\/|mailto:)/i.test(attribute.attrValue);
    } else if (attribute.attrName === 'src') {
      attribute.keepAttr = /^https?:\/\//i.test(attribute.attrValue);
    }
  });
  return sanitizer.sanitize(marked.parse(markdown, { async: false, breaks: true, gfm: true }), {
    ALLOWED_TAGS: safeTags,
    ALLOWED_ATTR: ['href', 'name', 'src', 'alt', 'title', 'class'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:)/i,
  });
}

export function parseBrowserCards(
  text: string,
  source: string,
  render: (markdown: string) => string = renderBrowserMarkdown,
): Card[] {
  return parseCardRanges(text, source).map(({ content }) => ({
    ...content,
    id: crypto.randomUUID(),
    source,
    questionHtml: render(content.question),
    answerHtml: render(content.answer),
  }));
}
