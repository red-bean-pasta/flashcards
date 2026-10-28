import { OneDriveAuthError } from './auth.js';

export function createFolderMemory(clientId: string, storage: () => Pick<Storage, 'getItem' | 'setItem'>) {
  const key = `flashcards.onedrive.folder.${clientId}`;

  function remember(id: string, rootId: string): void {
    try { storage().setItem(key, JSON.stringify({ id, rootId })); }
    catch (failure) {
      if (!(failure instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(failure.name)) throw failure;
      throw new OneDriveAuthError('Could not remember the OneDrive folder in this browser session.', 'storage', { cause: failure });
    }
  }

  function recall(rootId: string): string | null {
    let raw: string | null;
    try { raw = storage().getItem(key); }
    catch (failure) {
      if (!(failure instanceof DOMException) || failure.name !== 'SecurityError') throw failure;
      throw new OneDriveAuthError('Browser session storage is unavailable.', 'storage', { cause: failure });
    }
    if (raw === null) return null;
    let saved: unknown;
    try { saved = JSON.parse(raw); }
    catch (failure) {
      if (!(failure instanceof SyntaxError)) throw failure;
      throw new OneDriveAuthError('The saved folder selection is invalid. Disconnect and reconnect OneDrive.', 'storage', { cause: failure });
    }
    if (typeof saved !== 'object' || saved === null || !('id' in saved) || !('rootId' in saved)
      || typeof saved.id !== 'string' || typeof saved.rootId !== 'string') {
      throw new OneDriveAuthError('The saved folder selection is invalid. Disconnect and reconnect OneDrive.', 'storage');
    }
    return saved.rootId === rootId ? saved.id : null;
  }

  return { remember, recall };
}

export type FolderMemory = ReturnType<typeof createFolderMemory>;
