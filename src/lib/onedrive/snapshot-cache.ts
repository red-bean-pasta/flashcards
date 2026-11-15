import { openIndexedDb, runIdbRequest, runIdbTransaction } from '../idb.js';

/** Temporary per-connection file snapshots. No tokens are stored here. */
export interface FileSnapshot { id: string; text: string; revision: string }
export interface SnapshotCache {
  get(name: string): Promise<FileSnapshot | null | undefined>;
  put(name: string, value: FileSnapshot | null): Promise<void>;
  clear(): Promise<void>;
}

export function createSnapshotCache(): SnapshotCache {
  const scope = crypto.randomUUID();
  const prefix = `${scope}:`;
  let db: Promise<IDBDatabase> | undefined;
  function open(): Promise<IDBDatabase> {
    return db ??= openIndexedDb({
      name: 'flashcards-onedrive-snapshots',
      version: 1,
      blockedMessage: 'Snapshot storage is blocked by another tab.',
      onUpgrade: database => { database.createObjectStore('snapshots'); },
    });
  }
  async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await open();
    return runIdbRequest(database, 'snapshots', mode, 'Snapshot storage transaction aborted.', run);
  }
  return {
    get: name => transaction('readonly', store => store.get(prefix + name)),
    async put(name, value) { await transaction('readwrite', store => store.put(value, prefix + name)); },
    async clear() {
      if (!db) return;
      const database = await db;
      await runIdbTransaction(database, 'snapshots', 'readwrite', 'Snapshot cleanup aborted.', tx => {
        const cursor = tx.objectStore('snapshots').openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
        cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
      });
      database.close();
    },
  };
}
