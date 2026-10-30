const providerKey = 'flashcards.storage.provider';
export type StorageProvider = 'local' | 'onedrive';
export function lastProvider(): StorageProvider | null {
  const value = localStorage.getItem(providerKey);
  if (value === null || value === 'local' || value === 'onedrive') return value;
  throw new Error('Invalid saved storage provider.');
}
export function rememberProvider(value: StorageProvider) { localStorage.setItem(providerKey, value); }

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('flashcards-storage', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('folders');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function folderTransaction(value?: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('folders', value ? 'readwrite' : 'readonly');
      const request = value ? tx.objectStore('folders').put(value, 'last') : tx.objectStore('folders').get('last');
      let result: FileSystemDirectoryHandle | undefined;
      request.onsuccess = () => { if (!value) result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export function recallLocalFolder() { return folderTransaction(); }
export async function rememberLocalFolder(handle: FileSystemDirectoryHandle): Promise<void> { await folderTransaction(handle); }
