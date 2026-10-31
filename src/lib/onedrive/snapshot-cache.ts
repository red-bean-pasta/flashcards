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
    return db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('flashcards-onedrive-snapshots', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Snapshot storage is blocked by another tab.'));
    });
  }
  async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('snapshots', mode);
      const request = run(tx.objectStore('snapshots'));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Snapshot storage transaction aborted.'));
    });
  }
  return {
    get: name => transaction('readonly', store => store.get(prefix + name)),
    async put(name, value) { await transaction('readwrite', store => store.put(value, prefix + name)); },
    async clear() {
      if (!db) return;
      const database = await db;
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('snapshots', 'readwrite');
        const cursor = tx.objectStore('snapshots').openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
        cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Snapshot cleanup aborted.'));
      });
      database.close();
    },
  };
}
