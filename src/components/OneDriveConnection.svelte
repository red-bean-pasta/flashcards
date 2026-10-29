<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { createOneDrivePicker } from '../lib/onedrive/picker';
  import { createOneDriveAuth, OneDriveAuthError, type OneDriveAuth } from '../lib/onedrive/auth';
  import { createGraphClient, GraphError, type GraphClient, type GraphItem } from '../lib/onedrive/graph';
  import { createFolderConnection, type ConnectedFolder, type FolderConnection } from '../lib/onedrive/connection';
  import { createFolderMemory } from '../lib/onedrive/folder-memory';
  import { DeckRequestError } from '../lib/deck-client';
  import type { DeckBackend } from '../lib/deck-backend';

  let { onBackend, onBusy, onPickerChange, pickerWidth, onPickerWidth, onPickerResizing, active = 'local', canSwitch = true }: {
    onBackend: (backend: DeckBackend | null) => void; onBusy: (busy: boolean) => void; onPickerChange: (open: boolean) => void;
    pickerWidth: number; onPickerWidth: (width: number) => void; onPickerResizing: (resizing: boolean) => void;
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
  let pickerOpen = $state(false);
  let pickerFrame = $state<HTMLIFrameElement>();
  let pickerMounted = $state(false);
  let picker: ReturnType<typeof createOneDrivePicker> | undefined;
  let pickerTrigger: HTMLElement | null = null;
  let pickerGeneration = $state(0);
  let pickerStarting = false;
  let pickerTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  const pickerRefreshInterval = 3 * 60 * 1000;

  function cancelPickerRefresh() {
    if (pickerTimer !== undefined) clearTimeout(pickerTimer);
    pickerTimer = undefined;
  }

  function schedulePickerRefresh() {
    cancelPickerRefresh();
    if (!pickerOpen && pickerMounted && !destroyed) {
      pickerTimer = setTimeout(() => { void refreshPicker(); }, pickerRefreshInterval);
    }
  }

  async function refreshPicker() {
    if (pickerStarting || picker?.isSelecting()) return;
    cancelPickerRefresh();
    pickerStarting = true;
    picker?.dispose();
    picker = undefined;
    pickerGeneration++;
    try {
      await tick();
      if (destroyed || !pickerMounted) return;
      if (!auth || !pickerFrame) throw new Error('OneDrive picker cannot start without authentication and a frame.');
      picker = createOneDrivePicker(pickerFrame, () => auth!.getPickerToken(), selectPickerFolder, closePicker, pickerFailure);
    } finally {
      pickerStarting = false;
      schedulePickerRefresh();
    }
  }

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

  function resizePicker(clientX: number) {
    const minimum = window.innerHeight * 0.4 / window.innerWidth * 100;
    onPickerWidth(Math.min(75, Math.max(minimum, clientX / window.innerWidth * 100)));
  }

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    onPickerResizing(true);
    resizePicker(event.clientX);
  }

  function moveResize(event: PointerEvent) {
    if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) resizePicker(event.clientX);
  }

  function resizeWithKeyboard(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    resizePicker((pickerWidth + (event.key === 'ArrowRight' ? 2 : -2)) / 100 * window.innerWidth);
  }

  function closePicker() {
    if (picker?.isSelecting()) return;
    const wasOpen = pickerOpen;
    pickerOpen = false;
    onPickerChange(false);
    schedulePickerRefresh();
    if (wasOpen) void tick().then(() => pickerTrigger?.focus());
  }

  async function selectPickerFolder(folder: { id: string; driveId: string }) {
    if (!pickerOpen) throw new DeckRequestError('Open the folder picker before selecting a folder.');
    if (!graph) throw new Error('OneDrive client has not been connected.');
    busy = true;
    onBusy(true);
    try {
      const item = await graph.getItem(folder.id);
      const driveId = item.parentReference?.driveId;
      if (!driveId || driveId.toLowerCase() !== folder.driveId.toLowerCase()) throw new DeckRequestError('The picker and app must use the same OneDrive account. Reconnect and sign in with the same account.');
      if (!item.folder) throw new DeckRequestError('The selected item is not a folder in the connected OneDrive.');
      await selectFolder(item);
    } finally { busy = false; onBusy(false); }
  }

  function pickerFailure(failure: unknown) {
    picker = undefined;
    pickerMounted = false;
    cancelPickerRefresh();
    closePicker();
    if (!(failure instanceof OneDriveAuthError || failure instanceof GraphError || failure instanceof DeckRequestError)) throw failure;
    actionError = failure.message;
  }

  async function openPicker() {
    if (!auth || !graph) throw new Error('OneDrive client has not been connected.');
    if (pickerOpen) { closePicker(); return; }
    cancelPickerRefresh();
    pickerTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    actionError = '';
    pickerOpen = true;
    onPickerChange(true);
    if (!pickerMounted) {
      pickerMounted = true;
      await refreshPicker();
    }
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
    return () => { destroyed = true; cancelPickerRefresh(); picker?.dispose(); };
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

  .picker-pane { position: fixed; z-index: 10; inset: 0 auto 0 0; width: clamp(40vh, var(--picker-width), 75vw); display: flex; flex-direction: column; background: var(--dialog-color, #f9f7f0); box-shadow: 2px 0 18px #0002; animation: picker-enter 300ms ease both; }
  .picker-hidden { visibility: hidden; pointer-events: none; animation: none; }
  .picker-header { display: flex; justify-content: space-between; align-items: center; padding: .8rem 1rem; }
  .picker-header-actions { display: flex; gap: 1rem; }
  .picker-pane iframe { border: 0; width: 100%; flex: 1; min-height: 0; }
  .picker-resize { position: absolute; z-index: 1; top: 0; right: -6px; bottom: 0; width: 12px; cursor: col-resize; touch-action: none; }
  .picker-resize:focus-visible { outline: 2px solid #9ca98d; outline-offset: -3px; }
  @media (aspect-ratio < 5/6) { .picker-pane { width: min(100vw, 40vh); } .picker-resize { display: none; } }
  @keyframes picker-enter { from { transform: translateX(-100%); } to { transform: translateX(0); } }
  @media (prefers-reduced-motion: reduce) { .picker-pane { animation: none; } }
</style>

<svelte:window onkeydown={event => { if (pickerOpen && event.key === 'Escape') closePicker(); }} />
{#if pickerMounted}
  <aside class="picker-pane" class:picker-hidden={!pickerOpen} inert={!pickerOpen} aria-hidden={!pickerOpen} aria-label="Choose a OneDrive folder">
    <div class="picker-header"><span>Choose a folder</span><div class="picker-header-actions"><button class="text-action" disabled={busy} onclick={refreshPicker} aria-label="Refresh folder picker">Refresh</button><button class="text-action" disabled={busy} onclick={closePicker} aria-label="Close folder picker">Close</button></div></div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions: A focusable separator is the accessible window-splitter pattern. -->
    <div class="picker-resize" role="separator" tabindex="0" aria-label="Resize folder picker" aria-orientation="vertical" aria-valuemin="1" aria-valuemax="75" aria-valuenow={Math.round(pickerWidth)} onpointerdown={startResize} onpointermove={moveResize} onlostpointercapture={() => onPickerResizing(false)} onkeydown={resizeWithKeyboard}></div>
    {#key pickerGeneration}<iframe bind:this={pickerFrame} title="OneDrive folder picker"></iframe>{/key}
  </aside>
{/if}
