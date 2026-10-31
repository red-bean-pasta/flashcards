import type { DeckBackend } from '../deck-backend.js';
import { type GraphClient, type GraphItem } from './graph.js';
import type { FolderMemory } from './folder-memory.js';
import { createOneDriveStore } from './store.js';

export interface ConnectedFolder {
  folder: GraphItem;
  backend: DeckBackend;
}

/** Connect a folder to its browser-persistent mutation queue. */
export function createFolderConnection(graph: GraphClient, memory: FolderMemory, onChange: (state: ConnectedFolder) => void) {
  let current: ReturnType<typeof createOneDriveStore> | undefined;
  async function select(folder: GraphItem): Promise<void> {
    const root = await graph.root();
    const driveId = await graph.driveId();
    memory.remember(folder.id, root.id);
    const store = createOneDriveStore(graph, folder);
    const previous = current;
    current = store;
    onChange({ folder, backend: {
      load: signal => store.load(signal),
      mutate: (request, snapshot) => store.mutate(request, snapshot),
      persistent: {
        destination: { provider: 'onedrive', driveId, folderId: folder.id },
        execute: (item, checkpoint, recovered) => store.execute(item, checkpoint, recovered),
      },
    } });
    if (previous) await previous.dispose();
  }

  async function useDefault(): Promise<void> {
    await select(await graph.root());
  }

  async function restore(): Promise<void> {
    const root = await graph.root();
    const previous = memory.recall(root.id);
    if (previous) await select(await graph.getItem(previous));
    else await useDefault();
  }

  async function dispose(): Promise<void> {
    const store = current;
    current = undefined;
    if (store) await store.dispose();
  }

  return { select, useDefault, restore, dispose };
}

export type FolderConnection = ReturnType<typeof createFolderConnection>;
