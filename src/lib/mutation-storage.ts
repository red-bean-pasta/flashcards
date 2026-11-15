import type { CardOperation } from './onedrive/operations.js';
import type { DeckState, MutationRequest } from './types.js';
import { DeckRequestError } from './deck-client.js';
import { openIndexedDb, runIdbRequest, runIdbTransaction, withOpenedIdb } from './idb.js';
import { validateSource } from './onedrive/operations.js';
import { archiveFilename } from './card-text.js';

export type MutationDestination =
  | { provider: 'onedrive'; driveId: string; folderId: string }
  | { provider: 'local'; folder: FileSystemDirectoryHandle };

export type MutationStage = 'queued' | 'preparing' | 'archive-ready' | 'archive-writing' | 'source-ready' | 'source-writing' | 'releasing';
export interface MutationWritePlan { name: string; id: string | null; revision: string | null; before: string | null; after: string }
export interface StoredMutation {
  id: string;
  createdAt: number;
  order?: number;
  destination: MutationDestination;
  request: MutationRequest;
  operation: CardOperation;
  snapshot: DeckState;
  stage: MutationStage;
  sourceWrite?: MutationWritePlan;
  archiveWrite?: MutationWritePlan;
  attempts: number;
  retryAt?: number;
  error?: string;
  review?: boolean;
  reconnect?: boolean;
  retryBlocked?: boolean;
}

const DATABASE = 'flashcards-mutations';
const STORE = 'operations';
const META = 'metadata';

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function isMutationDestination(value: unknown): value is MutationDestination {
  if (!record(value)) return false;
  if (value.provider === 'onedrive') {
    return typeof value.driveId === 'string' && !!value.driveId && typeof value.folderId === 'string' && !!value.folderId;
  }
  return value.provider === 'local' && record(value.folder) && value.folder.kind === 'directory' && typeof value.folder.isSameEntry === 'function';
}
function pair(value: unknown): boolean { return record(value) && typeof value.question === 'string' && typeof value.answer === 'string'; }
function plan(value: unknown, name: string): boolean {
  return record(value) && value.name === name && (value.id === null || typeof value.id === 'string' && !!value.id) &&
    (value.revision === null || typeof value.revision === 'string' && !!value.revision) &&
    (value.before === null || typeof value.before === 'string') && typeof value.after === 'string';
}
function validItem(value: unknown): value is StoredMutation {
  if (!record(value) || typeof value.id !== 'string' || !value.id || !Number.isSafeInteger(value.createdAt) ||
      !Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0 ||
      !['queued', 'preparing', 'archive-ready', 'archive-writing', 'source-ready', 'source-writing', 'releasing'].includes(value.stage as string)) return false;
  if ((value.retryAt !== undefined && (typeof value.retryAt !== 'number' || !Number.isFinite(value.retryAt))) ||
      (value.error !== undefined && typeof value.error !== 'string') ||
      (value.review !== undefined && typeof value.review !== 'boolean') || (value.reconnect !== undefined && typeof value.reconnect !== 'boolean') ||
      (value.retryBlocked !== undefined && typeof value.retryBlocked !== 'boolean')) return false;
  if (!isMutationDestination(value.destination)) return false;
  const operation = value.operation, request = value.request, snapshot = value.snapshot;
  if (!record(operation) || !record(request) || !record(snapshot) || typeof operation.source !== 'string' || request.source !== operation.source || request.action !== operation.action ||
      !['add', 'edit', 'remove'].includes(operation.action as string) || !Array.isArray(snapshot.cards) || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.errors) || !record(snapshot.revisions)) return false;
  if (!(request.revision === null || typeof request.revision === 'string') ||
      !snapshot.files.every(file => typeof file === 'string') || !snapshot.errors.every(error => typeof error === 'string') ||
      !Object.values(snapshot.revisions).every(revision => typeof revision === 'string') ||
      !snapshot.cards.every(card => record(card) && typeof card.id === 'string' && !!card.id && typeof card.source === 'string' &&
        Number.isInteger(card.line) && typeof card.question === 'string' && typeof card.answer === 'string' &&
        Number.isSafeInteger(card.seen) && (card.seen as number) >= 0 &&
        typeof card.questionHtml === 'string' && typeof card.answerHtml === 'string')) return false;
  try { validateSource(operation.source); } catch (error) { if (error instanceof DeckRequestError) return false; throw error; }
  if (operation.action !== 'add' && (!pair(operation.original) || !Number.isInteger(request.index) || (request.index as number) < 0)) return false;
  if (operation.action !== 'remove' && (!pair(operation.replacement) || !record(operation.replacement) || request.question !== operation.replacement.question || request.answer !== operation.replacement.answer)) return false;
  if (value.sourceWrite !== undefined && !plan(value.sourceWrite, operation.source)) return false;
  if (value.archiveWrite !== undefined && !plan(value.archiveWrite, archiveFilename)) return false;
  if (['queued', 'preparing'].includes(value.stage as string) && (value.sourceWrite !== undefined || value.archiveWrite !== undefined)) return false;
  if (!['queued', 'preparing'].includes(value.stage as string) && !value.sourceWrite) return false;
  if ((value.stage === 'archive-ready' || value.stage === 'archive-writing') && (operation.action !== 'remove' || !value.archiveWrite)) return false;
  if (operation.action === 'remove' && value.sourceWrite && !value.archiveWrite) return false;
  if (operation.action !== 'remove' && value.archiveWrite) return false;
  return true;
}

function openDatabase(): Promise<IDBDatabase> {
  return openIndexedDb({
    name: DATABASE,
    version: 2,
    blockedMessage: 'The pending changes database is blocked by another browser tab.',
    upgradeErrorMessage: 'The pending changes database uses an unsupported older version.',
    onUpgrade(db, event) {
      if (event.oldVersion !== 0) return false;
      db.createObjectStore(STORE, { keyPath: 'id' });
      db.createObjectStore(META).put(0, 'lastOrder');
    },
  });
}

function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return withOpenedIdb(openDatabase, db =>
    runIdbRequest(db, STORE, mode, 'The pending changes transaction was aborted.', action),
  );
}

export const mutationStorage = {
  async list(): Promise<StoredMutation[]> {
    const items = await transaction('readonly', store => store.getAll());
    if (!items.every(validItem)) throw new DeckRequestError('Saved pending changes are invalid. Do not remove browser data; inspect the pending changes before continuing.');
    if (items.some(item => typeof item.order !== 'number' || !Number.isSafeInteger(item.order) || item.order < 1)) throw new DeckRequestError('Saved pending changes have invalid ordering.');
    if (new Set(items.map(item => item.order)).size !== items.length) throw new DeckRequestError('Saved pending changes have duplicate ordering.');
    return (items as StoredMutation[]).sort((a, b) => a.order! - b.order!);
  },
  async enqueue(item: StoredMutation): Promise<void> {
    await withOpenedIdb(openDatabase, db =>
      runIdbTransaction(db, [STORE, META], 'readwrite', 'Could not allocate pending change order.', tx => {
        const meta = tx.objectStore(META);
        const request = meta.get('lastOrder');
        request.onsuccess = () => {
          if (!Number.isSafeInteger(request.result) || request.result < 0 || request.result >= Number.MAX_SAFE_INTEGER) { tx.abort(); return; }
          item.order = request.result + 1;
          meta.put(item.order, 'lastOrder');
          tx.objectStore(STORE).add(item);
        };
      }),
    );
  },
  async put(item: StoredMutation): Promise<void> { await transaction('readwrite', store => store.put(item)); },
  async remove(id: string): Promise<void> { await transaction('readwrite', store => store.delete(id)); },
};

export async function sameDestination(a: MutationDestination, b: MutationDestination): Promise<boolean> {
  if (a.provider === 'onedrive' && b.provider === 'onedrive') return a.driveId === b.driveId && a.folderId === b.folderId;
  if (a.provider === 'local' && b.provider === 'local') return a.folder.isSameEntry(b.folder);
  return false;
}
