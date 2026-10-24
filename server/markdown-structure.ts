import { fromMarkdown } from 'mdast-util-from-markdown';
import type { RootContent } from 'mdast';

export type Span = { start: number; end: number };
export type Marker = Span & { kind: 'question' | 'answer'; line: number };
export type MarkdownStructure = { markers: Marker[]; ignored: Span[] };

function sourceSpan(node: RootContent): Span {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new Error('Markdown parser contract violated: root node has no source offsets.');
  }
  return { start, end };
}

function cardMarker(node: RootContent, raw: string, span: Span): Marker | undefined {
  if (node.type !== 'heading' || node.depth !== 1) return;
  const match = /^ {0,3}#\s+(question|answer)\s*#*\s*$/i.exec(raw);
  if (!match) return;
  const line = node.position?.start.line;
  if (line === undefined) throw new Error('Markdown parser contract violated: heading has no source line.');
  return { ...span, kind: match[1].toLowerCase() as Marker['kind'], line };
}

function ignoredSeparator(node: RootContent, raw: string, span: Span): Span | undefined {
  if (node.type === 'thematicBreak' && raw.trim() === '---') return span;
  // Without a blank line, Markdown treats --- as a setext heading underline.
  if (node.type === 'heading' && node.depth === 2 && /\n {0,3}---[ \t]*$/.test(raw)) {
    return { start: span.start + raw.lastIndexOf('\n') + 1, end: span.end };
  }
}

export function inspectMarkdown(text: string): MarkdownStructure {
  const structure: MarkdownStructure = { markers: [], ignored: [] };
  // Root nodes only: fenced, quoted and list-nested headings are ordinary content.
  for (const node of fromMarkdown(text).children) {
    const span = sourceSpan(node);
    const raw = text.slice(span.start, span.end);
    const marker = cardMarker(node, raw, span);
    const separator = ignoredSeparator(node, raw, span);
    if (marker) structure.markers.push(marker);
    if (separator) structure.ignored.push(separator);
  }
  return structure;
}

export function extractContent(text: string, start: number, end: number, ignored: Span[]): string {
  let cursor = start;
  let content = '';
  for (const span of ignored) {
    if (span.start < start || span.end > end) continue;
    content += text.slice(cursor, span.start);
    cursor = span.end;
  }
  return (content + text.slice(cursor, end)).trim();
}
