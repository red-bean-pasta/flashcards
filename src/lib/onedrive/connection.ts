import { DeckRequestError } from '../deck-client.js';
import type { DeckBackend } from '../deck-backend.js';
import { GraphError, type GraphClient, type GraphItem } from './graph.js';
import type { FolderMemory } from './folder-memory.js';
import type { PendingOperation } from './journal.js';
import { createOneDriveStore, type OneDriveStore } from './store.js';

export interface ConnectedFolder {
  folder: GraphItem;
  backend: DeckBackend;
  recovery: PendingOperation | null;
  recoveryError: string;
}

interface FolderSession { state: ConnectedFolder; store: OneDriveStore }

/** Own the backend and recovery information for exactly one selected folder. */
export function createFolderConnection(graph: GraphClient, memory: FolderMemory, onChange: (state: ConnectedFolder) => void) {
  let current: FolderSession | undefined;

  function requireSession(): FolderSession {
    if (!current) throw new Error('Recovery requires a connected folder.');
    return current;
  }

  function publishRecovery(session: FolderSession, recovery: PendingOperation | null, recoveryError = '') {
    if (current !== session) throw new Error('The selected folder changed during recovery inspection.');
    session.state = { ...session.state, recovery, recoveryError };
    onChange(session.state);
  }

  async function refreshRecovery(session: FolderSession): Promise<void> {
    let recovery: PendingOperation | null;
    try { recovery = await session.store.pending(); }
    catch (failure) {
      if (!(failure instanceof DeckRequestError)) throw failure;
      publishRecovery(session, session.state.recovery, failure.message);
      return;
    }
    publishRecovery(session, recovery);
  }

  async function inspectAfter<T>(session: FolderSession, operation: () => Promise<T>): Promise<T> {
    let result: T;
    try { result = await operation(); }
    catch (failure) {
      try { await refreshRecovery(session); }
      catch (inspectionFailure) {
        throw new AggregateError([failure, inspectionFailure], 'OneDrive operation and recovery inspection both failed.');
      }
      throw failure;
    }
    await refreshRecovery(session);
    return result;
  }

  function prepareSession(folder: GraphItem, store: OneDriveStore, recovery: PendingOperation | null): FolderSession {
    const session: FolderSession = {
      store,
      state: {
        folder, recovery, recoveryError: '',
        backend: {
          load: signal => store.load(signal),
          mutate: (request, snapshot) => inspectAfter(session, () => store.mutate(request, snapshot)),
        },
      },
    };
    return session;
  }

  async function select(folder: GraphItem): Promise<void> {
    const store = createOneDriveStore(graph, folder);
    const recovery = await store.pending();
    const root = await graph.root();
    memory.remember(folder.id, root.id);
    const session = prepareSession(folder, store, recovery);
    current = session;
    onChange(session.state);
  }

  async function useDefault(): Promise<void> {
    const root = await graph.root();
    let folder = await graph.findChild(root.id, 'My Flashcards');
    if (!folder) {
      try { folder = await graph.createFolder(root.id, 'My Flashcards'); }
      catch (failure) {
        if (!(failure instanceof GraphError) || failure.status !== 409) throw failure;
        folder = await graph.findChild(root.id, 'My Flashcards');
      }
    }
    if (!folder?.folder) throw new DeckRequestError('My Flashcards exists but is not a folder. Choose an existing folder instead.');
    await select(folder);
  }

  async function restore(): Promise<void> {
    const root = await graph.root();
    const previous = memory.recall(root.id);
    if (previous) await select(await graph.getItem(previous));
    else await useDefault();
  }

  async function retryPending(): Promise<void> {
    const session = requireSession();
    await inspectAfter(session, () => session.store.recover());
    // Recovery is followed by an explicit reload, never a guessed projection.
    await select(session.state.folder);
  }

  async function clearReviewed(): Promise<void> {
    const session = requireSession();
    const recovery = session.state.recovery;
    if (!recovery) throw new Error('No pending operation to review.');
    await session.store.clearReviewed(recovery.id);
    publishRecovery(session, null);
  }

  return { select, useDefault, restore, retryPending, clearReviewed };
}

export type FolderConnection = ReturnType<typeof createFolderConnection>;
