import { DeckRequestError } from './deck-client.js';
import { openIndexedDb, runIdbRequest, withOpenedIdb } from './idb.js';
import { isMutationDestination, type MutationDestination } from './mutation-storage.js';
import { validateSource, type SeenIncrement } from './onedrive/operations.js';

export interface StoredSeenBatch {
  id: string;
  destination: MutationDestination;
  source: string;
  increments: SeenIncrement[];
  attempts: number;
  retryAt?: number;
}

const DATABASE = 'flashcards-seen';
const STORE = 'batches';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validIncrement(value: unknown): value is SeenIncrement {
  return isRecord(value) &&
    typeof value.question === 'string' &&
    typeof value.answer === 'string' &&
    typeof value.delta === 'number' &&
    Number.isSafeInteger(value.delta) &&
    value.delta > 0;
}

function validSeenBatch(value: unknown): value is StoredSeenBatch {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return false;
  if (!isMutationDestination(value.destination)) return false;
  if (typeof value.source !== 'string') return false;
  try {
    validateSource(value.source);
  } catch (error) {
    if (error instanceof DeckRequestError) return false;
    throw error;
  }
  if (!Array.isArray(value.increments) || !value.increments.length || !value.increments.every(validIncrement)) return false;
  if (!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0) return false;
  if (value.retryAt !== undefined && (typeof value.retryAt !== 'number' || !Number.isFinite(value.retryAt))) return false;
  return true;
}

function openDatabase(): Promise<IDBDatabase> {
  return openIndexedDb({
    name: DATABASE,
    version: 1,
    blockedMessage: 'The seen count database is blocked by another browser tab.',
    onUpgrade: db => { db.createObjectStore(STORE, { keyPath: 'id' }); },
  });
}

function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return withOpenedIdb(openDatabase, db =>
    runIdbRequest(db, STORE, mode, 'The seen count transaction was aborted.', action),
  );
}

export const seenStorage = {
  async list(): Promise<StoredSeenBatch[]> {
    const items = await transaction('readonly', store => store.getAll());
    if (!items.every(validSeenBatch)) {
      throw new DeckRequestError('Saved seen count batches are invalid.');
    }
    return items;
  },
  async put(item: StoredSeenBatch): Promise<void> {
    if (!validSeenBatch(item)) {
      throw new Error('Cannot persist an invalid seen count batch.');
    }
    await transaction('readwrite', store => store.put(item));
  },
  async remove(id: string): Promise<void> {
    await transaction('readwrite', store => store.delete(id));
  },
};
