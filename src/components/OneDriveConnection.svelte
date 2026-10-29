<script lang="ts">
  import { onMount } from 'svelte';
  import { openOneDrivePicker } from '../lib/onedrive/picker';
  import { createOneDriveAuth, OneDriveAuthError, type OneDriveAuth } from '../lib/onedrive/auth';
  import { createGraphClient, GraphError, type GraphClient, type GraphItem } from '../lib/onedrive/graph';
  import { createFolderConnection, type ConnectedFolder, type FolderConnection } from '../lib/onedrive/connection';
  import { createFolderMemory } from '../lib/onedrive/folder-memory';
  import { DeckRequestError } from '../lib/deck-client';
  import type { DeckBackend } from '../lib/deck-backend';

  let { onBackend, onBusy, active = 'local', canSwitch = true }: {
    onBackend: (backend: DeckBackend | null) => void; onBusy: (busy: boolean) => void;
    active?: 'local' | 'onedrive'; canSwitch?: boolean;
  } = $props();
  const clientId = import.meta.env.VITE_ONEDRIVE_CLIENT_ID as string | undefined;
  let auth = $state<OneDriveAuth | undefined>();
  let graph = $state<GraphClient | undefined>();
  let connection: FolderConnection | undefined;
  // Controller snapshots are replaced as a whole; keep backend identity intact.
  let selected = $state.raw<ConnectedFolder | null>(null);
  const folder = $derived(selected?.folder);
  const recovery = $derived(selected?.recovery);
  const recoveryError = $derived(selected?.recoveryError ?? '');
  let busy = $state(false);
  let actionError = $state('');
  let recoveryOpen = $state(false);

  async function run(operation: () => Promise<void>) {
    if (busy) return;
    busy = true;
    onBusy(true);
    actionError = '';
    try { await operation(); }
    catch (failure) {
      if (!(failure instanceof OneDriveAuthError || failure instanceof GraphError || failure instanceof DeckRequestError)) throw failure;
      actionError = failure.message;
    } finally { busy = false; onBusy(false); }
  }

  function requireConnection(): FolderConnection {
    if (!connection) throw new Error('OneDrive client has not been connected.');
    return connection;
  }

  function applySelection(next: ConnectedFolder) {
    const changed = selected?.backend !== next.backend;
    selected = next;
    if (changed) {
      recoveryOpen = false;
      onBackend(next.backend);
    }
  }

  async function selectFolder(folder: GraphItem) {
    if (!canSwitch) throw new DeckRequestError('Wait for the current card operation before changing folders.');
    await requireConnection().select(folder);
  }

  function openPicker() {
    if (!auth || !graph) throw new Error('OneDrive client has not been connected.');
    if (!auth.hasPickerAuthorization()) { void run(() => auth!.startPickerSignIn()); return; }
    const picker = openOneDrivePicker(() => auth!.getPickerToken(), async folder => {
      const item = await graph!.getItem(folder.id);
      const driveId = item.parentReference?.driveId;
      if (!driveId || driveId.toLowerCase() !== folder.driveId.toLowerCase()) throw new DeckRequestError('The picker and app must use the same OneDrive account. Reconnect and sign in with the same account.');
      if (!item.folder) throw new DeckRequestError('The selected item is not a folder in the connected OneDrive.');
      await selectFolder(item);
    });
    void run(() => picker);
  }

  async function connect() {
    if (!auth || !clientId) throw new Error('OneDrive authentication was not initialized.');
    if (!auth.isConnected()) { await auth.startSignIn(); return; }
    graph = createGraphClient(() => auth!.getAccessToken());
    connection = createFolderConnection(graph, createFolderMemory(clientId, () => sessionStorage), applySelection);
    await connection.restore();
  }

  export function startConnection() {
    void run(connect);
  }

  async function clearReviewed() {
    if (!window.confirm('Keep the files currently in OneDrive and clear this pending save? Check the source and removed.md first. This does not undo or repeat any file change.')) return;
    await requireConnection().clearReviewed();
    recoveryOpen = false;
  }

  onMount(() => {
    if (!clientId) return;
    void run(async () => {
      auth = createOneDriveAuth({ clientId, redirectUri: new URL(import.meta.env.BASE_URL, location.origin).href });
      const returned = await auth!.completeSignIn();
      if (returned || auth!.isConnected()) await connect();
    });
  });
</script>

<aside class="storage-connection" aria-label="Card storage">
  <div class="storage-actions">
    {#if active === 'onedrive' && folder}
      <button class="text-action">OneDrive</button>
      <button class="text-action" disabled={busy || !canSwitch} onclick={openPicker}>{folder.name}</button>
    {:else}
      {#if import.meta.env.VITE_DEFAULT_STORAGE !== 'onedrive'}<span>Local notes</span>{/if}
      <button class="text-action" disabled={busy || !canSwitch || !clientId} onclick={startConnection}>Connect OneDrive</button>
    {/if}
  </div>
  {#if !clientId}<p class="storage-hint">OneDrive isn’t configured for this site.</p>{/if}
  {#if actionError || recoveryError}
    {#if actionError}<p role="alert" class="save-error">{actionError}</p>{/if}
    {#if recoveryError}<p role="alert" class="save-error">{recoveryError}</p>{/if}
    {#if auth}<button class="text-action" disabled={busy || !canSwitch} onclick={() => run(() => auth!.startSignIn())}>Reconnect OneDrive</button>{/if}
    {#if graph}<button class="text-action" disabled={busy || !canSwitch} onclick={openPicker}>Choose an existing folder</button>{/if}
  {/if}
  {#if recovery}
    <section class="pending-save" aria-label="Pending OneDrive save">
      <p role="status">A pending {recovery.action} in {recovery.source} needs review. Further saves are paused.</p>
      <button class="text-action" disabled={busy || !canSwitch} onclick={() => { recoveryOpen = !recoveryOpen; }}>Review pending save</button>
      {#if recoveryOpen}
        <p>Retry sends the same prepared write against its original revision. If the file changed, it stops. A timeout may have happened after the save succeeded.</p>
        <details><summary>Source before save</summary><pre>{recovery.sourceWrite.before ?? '(new file)'}</pre></details>
        <details><summary>Prepared source after save</summary><pre>{recovery.sourceWrite.after}</pre></details>
        {#if recovery.archiveWrite}<details><summary>Prepared removed.md</summary><pre>{recovery.archiveWrite.after}</pre></details>{/if}
        <button class="text-action" disabled={busy || !canSwitch} onclick={() => run(() => requireConnection().retryPending())}>Retry prepared save</button>
        <button class="text-action" disabled={busy || !canSwitch} onclick={() => run(clearReviewed)}>Keep current files and clear pending save</button>
      {/if}
    </section>
  {/if}
</aside>

<style>
  .storage-connection { position: absolute; z-index: 3; top: 1rem; left: 1.5rem; right: 1.5rem; font-size: .78rem; max-height: 40vh; overflow: auto; }
  .storage-actions { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
  .storage-hint { margin: .35rem 0; opacity: .7; }
  .pending-save { background: var(--dialog-color, #f9f7f0); border: 1px solid #aaa5; border-radius: .5rem; padding: .8rem; max-width: 42rem; margin-top: .5rem; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 12rem; overflow: auto; }
</style>
