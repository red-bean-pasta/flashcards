<script lang="ts">
  import { onMount } from 'svelte';
  import { createOneDriveAuth, OneDriveAuthError, type OneDriveAuth } from '../lib/onedrive/auth';
  import { createGraphClient, GraphError, type GraphClient, type GraphItem } from '../lib/onedrive/graph';
  import { createOneDriveStore, type OneDriveStore } from '../lib/onedrive/store';
  import { DeckRequestError } from '../lib/deck-client';
  import type { DeckBackend } from '../lib/deck-backend';
  import type { PendingOperation } from '../lib/onedrive/journal';

  let { onBackend, active = 'local', canSwitch = true }: {
    onBackend: (backend: DeckBackend | null) => void; active?: 'local' | 'onedrive'; canSwitch?: boolean;
  } = $props();
  const clientId = import.meta.env.VITE_ONEDRIVE_CLIENT_ID as string | undefined;
  let auth = $state<OneDriveAuth | undefined>();
  let graph = $state<GraphClient | undefined>();
  let store: OneDriveStore | undefined;
  let folder = $state<GraphItem | null>(null);
  let browsing = $state(false);
  let folders = $state<GraphItem[]>([]);
  let trail = $state<GraphItem[]>([]);
  let busy = $state(false);
  let error = $state('');
  let recovery = $state<PendingOperation | null>(null);
  let recoveryOpen = $state(false);
  const folderKey = `flashcards.onedrive.folder.${clientId}`;

  function rememberFolder(selected: GraphItem, rootId: string) {
    try { sessionStorage.setItem(folderKey, JSON.stringify({ id: selected.id, rootId })); }
    catch (failure) {
      if (!(failure instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(failure.name)) throw failure;
      throw new OneDriveAuthError('Could not remember the OneDrive folder in this browser session.', 'storage', { cause: failure });
    }
  }

  function rememberedFolder(rootId: string): string | null {
    let raw: string | null;
    try { raw = sessionStorage.getItem(folderKey); }
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
    if (typeof saved !== 'object' || saved === null || !('id' in saved) || !('rootId' in saved) || typeof saved.id !== 'string' || typeof saved.rootId !== 'string') {
      throw new OneDriveAuthError('The saved folder selection is invalid. Disconnect and reconnect OneDrive.', 'storage');
    }
    return saved.rootId === rootId ? saved.id : null;
  }

  async function refreshRecovery(nextStore: OneDriveStore) {
    try { recovery = await nextStore.pending(); }
    catch (failure) {
      if (!(failure instanceof DeckRequestError)) throw failure;
      error = failure.message;
    }
  }

  async function run(operation: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    try { await operation(); }
    catch (failure) {
      if (!(failure instanceof OneDriveAuthError || failure instanceof GraphError || failure instanceof DeckRequestError)) throw failure;
      error = failure.message;
    } finally { busy = false; }
  }

  function requireGraph(): GraphClient {
    if (!graph) throw new Error('OneDrive client has not been connected.');
    return graph;
  }

  async function selectFolder(selected: GraphItem) {
    if (!canSwitch) throw new DeckRequestError('Close the card dialog before changing folders.');
    const nextStore = createOneDriveStore(requireGraph(), selected);
    // Check access/recovery before replacing the active backend.
    recovery = await nextStore.pending();
    const root = await requireGraph().root();
    rememberFolder(selected, root.id);
    folder = selected;
    store = nextStore;
    browsing = false;
    onBackend({
      load: () => nextStore.load(),
      async mutate(request, snapshot) {
        try {
          const next = await nextStore.mutate(request, snapshot);
          await refreshRecovery(nextStore);
          return next;
        } catch (failure) { await refreshRecovery(nextStore); throw failure; }
      },
    });
  }

  async function defaultFolder() {
    const client = requireGraph();
    const root = await client.root();
    let target = await client.findChild(root.id, 'My Flashcards');
    if (!target) {
      try { target = await client.createFolder(root.id, 'My Flashcards'); }
      catch (failure) {
        if (!(failure instanceof GraphError) || failure.status !== 409) throw failure;
        target = await client.findChild(root.id, 'My Flashcards');
      }
    }
    if (!target?.folder) throw new DeckRequestError('My Flashcards exists but is not a folder. Choose an existing folder instead.');
    trail = [root];
    await selectFolder(target);
  }

  async function connect() {
    if (!auth) throw new Error('OneDrive authentication was not initialized.');
    if (!auth.isConnected()) { await auth.startSignIn(); return; }
    graph = createGraphClient(() => auth!.getAccessToken());
    const root = await graph.root();
    const previous = rememberedFolder(root.id);
    if (previous) await selectFolder(await graph.getItem(previous));
    else await defaultFolder();
  }

  async function browse(parent?: GraphItem) {
    const client = requireGraph();
    if (!parent) { parent = await client.root(); trail = [parent]; }
    folders = (await client.children(parent.id)).filter(item => !!item.folder && !item.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
    browsing = true;
  }

  async function enter(item: GraphItem) { await browse(item); trail = [...trail, item]; }
  async function up() {
    const next = trail.slice(0, -1);
    if (!next.length) throw new Error('Cannot navigate above OneDrive root.');
    await browse(next[next.length - 1]); trail = next;
  }

  function disconnect() {
    auth?.disconnect(); graph = undefined; store = undefined; folder = null;
    recovery = null; browsing = false; error = '';
    onBackend(null);
  }

  async function retryPending() {
    if (!store) throw new Error('Recovery requires a connected store.');
    try { await store.recover(); }
    catch (failure) { await refreshRecovery(store); throw failure; }
    await refreshRecovery(store);
    // A recovered operation requires explicit reload so its effect is not guessed.
    const selected = folder;
    if (!selected) throw new Error('Connected store lost its folder.');
    await selectFolder(selected);
  }

  async function clearReviewed() {
    if (!store || !recovery) throw new Error('No pending operation to review.');
    if (!window.confirm('Keep the files currently in OneDrive and clear this pending save? Check the source and removed.md first. This does not undo or repeat any file change.')) return;
    await store.clearReviewed(recovery.id);
    recovery = null;
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
      <span>OneDrive · {folder?.name ?? 'Connecting…'}</span>
      <button class="text-action" disabled={busy || !canSwitch} onclick={() => run(() => browse())}>Choose folder</button>
      <button class="text-action" disabled={busy || !canSwitch} onclick={() => run(defaultFolder)}>My Flashcards</button>
      <button class="text-action" disabled={busy || !canSwitch} onclick={disconnect}>Disconnect</button>
    {:else}
      <span>{import.meta.env.VITE_DEFAULT_STORAGE === 'onedrive' ? 'Connect your notes' : 'Local notes'}</span>
      <button class="text-action" disabled={busy || !canSwitch || !clientId} onclick={() => run(connect)}>Connect OneDrive</button>
    {/if}
  </div>
  {#if !clientId}<p class="storage-hint">OneDrive isn’t configured for this site.</p>{/if}
  {#if busy}<p role="status" class="storage-hint">Connecting…</p>{/if}
  {#if error}
    <p role="alert" class="save-error">{error}</p>
    {#if auth}<button class="text-action" disabled={busy || !canSwitch} onclick={() => run(() => auth!.startSignIn())}>Reconnect OneDrive</button>{/if}
    {#if graph}<button class="text-action" disabled={busy || !canSwitch} onclick={() => run(() => browse())}>Choose an existing folder</button>{/if}
  {/if}
  {#if browsing}
    <section class="folder-browser" aria-label="Select OneDrive folder">
      <p>{trail.map(item => item.name).join(' / ')}</p>
      <div class="storage-actions">
        <button class="text-action" disabled={busy || !canSwitch || trail.length < 2} onclick={() => run(up)}>Up</button>
        <button class="text-action" disabled={busy || !canSwitch} onclick={() => run(() => selectFolder(trail[trail.length - 1]))}>Use this folder</button>
        <button class="text-action" disabled={busy || !canSwitch} onclick={() => { browsing = false; }}>Cancel</button>
      </div>
      <ul>{#each folders as item (item.id)}<li><button class="text-action" disabled={busy || !canSwitch} onclick={() => run(() => enter(item))}>{item.name}</button></li>{/each}</ul>
      {#if !folders.length}<p>No subfolders.</p>{/if}
    </section>
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
        <button class="text-action" disabled={busy || !canSwitch} onclick={() => run(retryPending)}>Retry prepared save</button>
        <button class="text-action" disabled={busy || !canSwitch} onclick={() => run(clearReviewed)}>Keep current files and clear pending save</button>
      {/if}
    </section>
  {/if}
</aside>

<style>
  .storage-connection { position: absolute; z-index: 3; top: 1rem; left: 1.5rem; right: 1.5rem; font-size: .78rem; max-height: 40vh; overflow: auto; }
  .storage-actions { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
  .storage-hint { margin: .35rem 0; opacity: .7; }
  .folder-browser, .pending-save { background: var(--dialog-color, #f9f7f0); border: 1px solid #aaa5; border-radius: .5rem; padding: .8rem; max-width: 42rem; margin-top: .5rem; }
  ul { margin: .5rem 0; padding-left: 1.1rem; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 12rem; overflow: auto; }
</style>
