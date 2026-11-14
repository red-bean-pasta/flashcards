import { marked } from 'marked';
import { parseCardRanges } from './card-ranges.js';
import type { Card } from './types.js';

interface SanitizerElement {
  setHTML(html: string, options: { sanitizer: SanitizerConfig }): void;
}

const safeTags = [
  'address', 'article', 'aside', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hgroup', 'main', 'nav', 'section', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'hr', 'li', 'menu', 'ol', 'p', 'pre', 'ul', 'a', 'abbr', 'b', 'bdi', 'bdo',
  'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby',
  's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
  'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'img', 'del',
];

const safeAttributes = ['href', 'name', 'src', 'alt', 'title', 'class'];
const safeHrefPattern = /^(?:https?:\/\/|mailto:)/i;
const safeSrcPattern = /^https?:\/\//i;
const hasNativeSetHtml = typeof Element !== 'undefined' && 'setHTML' in Element.prototype;
const domPurifyFactory = typeof window !== 'undefined' && typeof document !== 'undefined' && !hasNativeSetHtml
  ? (await import('dompurify')).default
  : null;

function enforceSafeUrls(root: ParentNode): void {
  for (const element of root.querySelectorAll('[href], [src]')) {
    const href = element.getAttribute('href');
    if (href !== null && !safeHrefPattern.test(href)) {
      element.removeAttribute('href');
    }
    const src = element.getAttribute('src');
    if (src !== null && !safeSrcPattern.test(src)) {
      element.removeAttribute('src');
    }
  }
}

function applyTableWrapperAttributes(wrapper: Element): void {
  wrapper.setAttribute('tabindex', '0');
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', 'Table');
}

function wrapTables(root: ParentNode, doc: Document): void {
  for (const table of [...root.querySelectorAll('table')]) {
    const parent = table.parentElement;
    if (parent && parent.tagName === 'DIV' && parent.className === 'table-wrapper' && parent.childElementCount === 1) {
      applyTableWrapperAttributes(parent);
      continue;
    }
    const wrapper = doc.createElement('div');
    wrapper.className = 'table-wrapper';
    applyTableWrapperAttributes(wrapper);
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
}

export function renderSanitizedHtml(target: HTMLElement, rawHtml: string): void {
  if (typeof Element !== 'undefined' && 'setHTML' in Element.prototype) {
    (target as unknown as SanitizerElement).setHTML(rawHtml, {
      sanitizer: {
        elements: safeTags,
        attributes: safeAttributes,
        comments: false,
        dataAttributes: false,
      },
    });
  } else if (domPurifyFactory) {
    const purify = typeof domPurifyFactory === 'function' ? domPurifyFactory(window) : domPurifyFactory;
    const sanitizedNode = purify.sanitize(rawHtml, {
      ALLOWED_TAGS: [...safeTags, '#text'],
      ALLOWED_ATTR: safeAttributes,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      KEEP_CONTENT: false,
      ALLOWED_URI_REGEXP: safeHrefPattern,
      RETURN_DOM: true,
    });
    target.replaceChildren(...(sanitizedNode ? [...sanitizedNode.childNodes] : []));
  } else {
    throw new Error('HTML sanitization requires a browser Document environment.');
  }
  const ownerDocument = target.ownerDocument ?? document;
  enforceSafeUrls(target);
  wrapTables(target, ownerDocument);
}

/** Svelte action that sanitizes and mounts card HTML directly into the target element. */
export function safeHtml(node: HTMLElement, html: string) {
  renderSanitizedHtml(node, html);
  return {
    update(nextHtml: string) {
      renderSanitizedHtml(node, nextHtml);
    },
  };
}

export function sanitizeHtml(rawHtml: string): string {
  if (typeof document === 'undefined') {
    throw new Error('HTML sanitization requires a browser Document environment.');
  }
  const container = document.createElement('div');
  renderSanitizedHtml(container, rawHtml);
  return container.innerHTML;
}

export function renderBrowserMarkdown(markdown: string): string {
  return sanitizeHtml(marked.parse(markdown, { async: false, breaks: true, gfm: true }));
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
