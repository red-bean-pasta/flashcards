import { createHash } from 'node:crypto';

export function materialRevision(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
