import path from 'node:path';
import type { MutationRequest } from '../src/lib/types.js';

export class MutationError extends Error {
  constructor(message: string, public status = 400, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MutationError';
  }
}

export function validateMutation(value: unknown): MutationRequest {
  if (typeof value !== 'object' || value === null) throw new MutationError('Expected a card operation.');
  const item = value as Record<string, unknown>;
  if (!['add', 'edit', 'remove'].includes(item.action as string) || typeof item.source !== 'string' ||
      !(item.revision === null || typeof item.revision === 'string')) throw new MutationError('Invalid card operation.');
  if (item.action !== 'add' && (!Number.isInteger(item.index) || (item.index as number) < 0)) {
    throw new MutationError('Expected a card position.');
  }
  if (item.action !== 'remove' && (typeof item.question !== 'string' || typeof item.answer !== 'string' ||
      !item.question.trim() || !item.answer.trim())) throw new MutationError('Question and answer are required.');
  return item as unknown as MutationRequest;
}

export function destination(directory: string, source: string): string {
  if (!source || source.includes('\\') || source.includes('\0') || path.posix.isAbsolute(source) ||
      source.split('/').some(part => !part || part === '.' || part === '..') || !/\.md$/i.test(source) ||
      path.posix.basename(source).toLowerCase() === 'removed.md') throw new MutationError('Choose a Markdown file other than removed.md.');
  return path.join(directory, source);
}

