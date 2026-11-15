export interface OpenIndexedDbOptions {
  name: string;
  version: number;
  blockedMessage: string;
  upgradeErrorMessage?: string;
  onUpgrade: (db: IDBDatabase, event: IDBVersionChangeEvent) => boolean | void;
}

/** Open an IndexedDB database with consistent upgrade, error, and blocked handling. */
export function openIndexedDb(options: OpenIndexedDbOptions): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(options.name, options.version);
    let upgradeRejected = false;
    request.onupgradeneeded = event => {
      if (options.onUpgrade(request.result, event) === false) {
        upgradeRejected = true;
        request.transaction?.abort();
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      upgradeRejected && options.upgradeErrorMessage
        ? new Error(options.upgradeErrorMessage)
        : request.error,
    );
    request.onblocked = () => reject(new Error(options.blockedMessage));
  });
}

/** Run an IndexedDB transaction, resolving once the transaction commits. */
export function runIdbTransaction<T = void>(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  abortMessage: string,
  setup: (tx: IDBTransaction) => (() => T) | void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const readResult = setup(tx);
    tx.oncomplete = () => resolve((readResult ? readResult() : undefined) as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error(abortMessage));
  });
}

/** Run a single object-store request inside an IndexedDB transaction. */
export function runIdbRequest<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  abortMessage: string,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return runIdbTransaction(db, storeName, mode, abortMessage, tx => {
    const request = action(tx.objectStore(storeName));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    return () => result;
  });
}

/** Open an IndexedDB connection for one operation and always close it afterward. */
export async function withOpenedIdb<T>(
  open: () => Promise<IDBDatabase>,
  run: (db: IDBDatabase) => Promise<T>,
): Promise<T> {
  const db = await open();
  try {
    return await run(db);
  } finally {
    db.close();
  }
}
