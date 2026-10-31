<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { lastProvider } from '../lib/storage-memory';
  import { createOneDrivePicker } from '../lib/onedrive/picker';
  import { createOneDriveAuth, OneDriveAuthError, type OneDriveAuth } from '../lib/onedrive/auth';
  import { createGraphClient, GraphError, type GraphClient, type GraphItem } from '../lib/onedrive/graph';
  import { createFolderConnection, type ConnectedFolder, type FolderConnection } from '../lib/onedrive/connection';
  import { createFolderMemory } from '../lib/onedrive/folder-memory';
  import { DeckRequestError } from '../lib/deck-client';
  import type { DeckBackend } from '../lib/deck-backend';

  let { onBackend, onActivity, onPickerChange, pickerWidth, onPickerWidth, onPickerResizing, active = 'local', canSwitch = true }: {
    onBackend: (backend: DeckBackend, name: string) => void; onActivity: (activity: 'connecting' | 'working' | null) => void; onPickerChange: (open: boolean) => void;
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
  let busy = $state(false);
  let actionError = $state('');
  let redirecting = false;
  let pickerOpen = $state(false);
  type PickerSlot = { id: number; frame?: HTMLIFrameElement };
  let pickerSlots = $state<PickerSlot[]>([]);
  let activePickerId = $state<number | null>(null);
  let pickerMounted = $state(false);
  let pickerStarting = $state(false);
  let pickerTrigger: HTMLElement | null = null;
  let pickerTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let nextPickerId = 0;
  let candidateId: number | undefined;
  let candidateReady = false;
  const pickers = new Map<number, ReturnType<typeof createOneDrivePicker>>();
  let destroyed = false;
  const pickerRefreshInterval = 3 * 60 * 1000;

  function cancelPickerRefresh() {
    if (pickerTimer !== undefined) clearTimeout(pickerTimer);
    pickerTimer = undefined;
  }

  function clearReadyTimer() {
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    readyTimer = undefined;
  }

  function schedulePickerRefresh() {
    cancelPickerRefresh();
    if (!pickerOpen && pickerMounted && !pickerStarting && !destroyed) {
      pickerTimer = setTimeout(() => { void refreshPicker(); }, pickerRefreshInterval);
    }
  }

  function removePicker(id: number) {
    pickers.get(id)?.dispose();
    pickers.delete(id);
    pickerSlots = pickerSlots.filter(slot => slot.id !== id);
  }

  function promotePicker() {
    if (candidateId === undefined || !candidateReady || (activePickerId !== null && pickers.get(activePickerId)?.isSelecting())) return;
    const previous = activePickerId;
    activePickerId = candidateId;
    candidateId = undefined;
    candidateReady = false;
    pickerStarting = false;
    clearReadyTimer();
    if (previous !== null && previous !== activePickerId) removePicker(previous);
    schedulePickerRefresh();
  }

  function pickerReady(id: number) {
    if (candidateId !== id) return;
    candidateReady = true;
    clearReadyTimer();
    promotePicker();
  }

  function pickerFailure(id: number, failure: unknown) {
    if (destroyed || !pickerSlots.some(slot => slot.id === id)) return;
    if (!(failure instanceof OneDriveAuthError || failure instanceof GraphError || failure instanceof DeckRequestError)) throw failure;
    removePicker(id);
    if (candidateId === id) { candidateId = undefined; candidateReady = false; pickerStarting = false; clearReadyTimer(); }
    if (activePickerId === id) {
      if (candidateId !== undefined) removePicker(candidateId);
      candidateId = undefined; candidateReady = false; pickerStarting = false; clearReadyTimer();
      activePickerId = null; pickerMounted = false; closePicker();
    }
    actionError = failure.message;
    schedulePickerRefresh();
  }

  async function refreshPicker() {
    if (pickerStarting || (activePickerId !== null && pickers.get(activePickerId)?.isSelecting())) return;
    cancelPickerRefresh();
    pickerStarting = true;
    const id = ++nextPickerId;
    candidateId = id;
    candidateReady = false;
    pickerSlots.push({ id });
    if (activePickerId === null) activePickerId = id;
    await tick();
    if (destroyed || candidateId !== id) return;
    const frame = pickerSlots.find(slot => slot.id === id)?.frame;
    if (!auth || !frame) throw new Error('OneDrive picker cannot start without authentication and a frame.');
    const instance = createOneDrivePicker(frame, {
      getToken: () => auth!.getPickerToken(),
      select: folder => {
        if (activePickerId !== id) throw new DeckRequestError('This folder picker is not active.');
        return selectPickerFolder(folder);
      },
      onClose: () => { if (activePickerId === id) closePicker(); },
      onError: error => pickerFailure(id, error),
      onSelected: () => { if (activePickerId === id) { handlePickerSelected(); promotePicker(); } },
      onReady: () => pickerReady(id),
    });
    pickers.set(id, instance);
    readyTimer = setTimeout(() => pickerFailure(id, new DeckRequestError('The OneDrive folder picker did not respond. Please try refreshing it.')), 30000);
  }

  async function run(operation: () => Promise<void>, activity: 'connecting' | 'working' = 'working') {
    if (busy) return;
    busy = true;
    onActivity(activity);
    actionError = '';
    try { await operation(); }
    catch (failure) {
      if (!(failure instanceof OneDriveAuthError || failure instanceof GraphError || failure instanceof DeckRequestError)) throw failure;
      actionError = failure.message;
    } finally { busy = false; if (!redirecting) onActivity(null); }
  }

  function requireConnection(): FolderConnection {
    if (!connection) throw new Error('OneDrive client has not been connected.');
    return connection;
  }

  function applySelection(next: ConnectedFolder) {
    const changed = selected?.backend !== next.backend;
    selected = next;
    if (changed) {
      onBackend(next.backend, next.folder.name);
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

  export function closePicker(restoreFocus = true) {
    if (activePickerId !== null && pickers.get(activePickerId)?.isSelecting()) return;
    const wasOpen = pickerOpen;
    pickerOpen = false;
    onPickerChange(false);
    schedulePickerRefresh();
    if (wasOpen && restoreFocus) void tick().then(() => pickerTrigger?.focus());
  }

  function handlePickerSelected() {
    if (window.matchMedia('(aspect-ratio < 5/6)').matches) closePicker();
  }

  async function selectPickerFolder(folder: { id: string; driveId: string }) {
    if (!pickerOpen) throw new DeckRequestError('Open the folder picker before selecting a folder.');
    if (!graph) throw new Error('OneDrive client has not been connected.');
    busy = true;
    onActivity('working');
    try {
      const item = await graph.getItem(folder.id);
      const driveId = item.parentReference?.driveId;
      if (!driveId || driveId.toLowerCase() !== folder.driveId.toLowerCase()) throw new DeckRequestError('The picker and app must use the same OneDrive account. Reconnect and sign in with the same account.');
      if (!item.folder) throw new DeckRequestError('The selected item is not a folder in the connected OneDrive.');
      await selectFolder(item);
    } finally { busy = false; onActivity(null); }
  }

  async function preparePicker() {
    if (destroyed || pickerMounted) return;
    pickerMounted = true;
    await refreshPicker();
  }

  export async function openPicker() {
    if (!auth || !graph) throw new Error('OneDrive client has not been connected.');
    if (pickerOpen) { closePicker(); return; }
    cancelPickerRefresh();
    pickerTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    actionError = '';
    pickerOpen = true;
    onPickerChange(true);
    await preparePicker();
  }

  async function connect() {
    if (!auth || !clientId) throw new Error('OneDrive authentication was not initialized.');
    if (!auth.isConnected()) { await auth.startSignIn(); return; }
    graph = createGraphClient(() => auth!.getAccessToken());
    connection = createFolderConnection(graph, createFolderMemory(clientId, () => localStorage), applySelection);
    await connection.restore();
    void preparePicker();
  }

  export async function startConnection() {
    if (!clientId) { actionError = "OneDrive isn’t configured for this site."; return; }
    if (selected) { actionError = ''; onBackend(selected.backend, selected.folder.name); return; }
    await run(connect, 'connecting');
  }

  export function clearActionError() { actionError = ''; }

  onMount(() => {
    if (!clientId) { onActivity(null); return; }
    const restoring = lastProvider() === 'onedrive' || new URLSearchParams(location.search).has('code') || new URLSearchParams(location.search).has('error');
    void run(async () => {
      auth = createOneDriveAuth({ clientId, redirectUri: new URL(import.meta.env.BASE_URL, location.origin).href });
      const returned = await auth!.completeSignIn();
      if (returned) { sessionStorage.removeItem('flashcards.restore.attempted'); await connect(); }
      else if (lastProvider() === 'onedrive') {
        if (auth!.isConnected()) await connect();
        else if (!sessionStorage.getItem('flashcards.restore.attempted')) {
          sessionStorage.setItem('flashcards.restore.attempted', '1');
          redirecting = true;
          try { await auth!.startAutomaticSignIn(); }
          catch (error) { redirecting = false; throw error; }
        }
      }
    }, restoring ? 'connecting' : 'working');
    return () => { destroyed = true; cancelPickerRefresh(); clearReadyTimer(); for (const instance of pickers.values()) instance.dispose(); void connection?.dispose().catch(error => console.error('Could not clear the OneDrive snapshot cache.', error)); };
  });
</script>

<aside class="storage-connection onedrive-status" aria-label="OneDrive status" class:has-status={!!actionError}>
  {#if actionError}
    {#if actionError}<p role="alert" class="save-error">{actionError}</p>{/if}
    {#if auth}<button class="text-action" disabled={busy || !canSwitch} onclick={() => run(() => auth!.startSignIn())}>Reconnect OneDrive</button>{/if}
    {#if graph}<button class="text-action" disabled={busy || !canSwitch} onclick={openPicker}>Choose an existing folder</button>{/if}
  {/if}
</aside>

<style>
  .onedrive-status:not(.has-status) { display: none; }
  .onedrive-status.has-status { top: 3rem; right: auto; }

  .picker-pane { position: fixed; z-index: 0; inset: 0 auto 0 0; width: clamp(40vh, var(--picker-width), 75vw); display: flex; flex-direction: column; background: var(--dialog-color, #f9f7f0); visibility: visible; transition: visibility 0s; }
  .picker-hidden { visibility: hidden; pointer-events: none; transition: visibility 0s 300ms; }
  .picker-header { display: flex; justify-content: space-between; align-items: center; padding: .8rem 1rem; }
  .picker-header-actions { display: flex; gap: 1rem; }
  .picker-frames { position: relative; flex: 1; min-height: 0; }
  .picker-pane iframe { position: absolute; inset: 0; border: 0; width: 100%; height: 100%; }
  .picker-pane iframe.pending { opacity: 0; pointer-events: none; }
  .picker-resize { position: absolute; z-index: 1; top: 0; right: 0; bottom: 0; width: 12px; cursor: col-resize; touch-action: none; }
  .picker-resize:focus-visible { outline: 2px solid #9ca98d; outline-offset: -3px; }
  @media (aspect-ratio < 5/6) { .picker-pane { width: min(100vw, 40vh); } .picker-resize { display: none; } }
  @media (prefers-reduced-motion: reduce) { .picker-pane { transition: none; } }
</style>

<svelte:window onkeydown={event => { if (pickerOpen && event.key === 'Escape') closePicker(); }} />
{#if pickerMounted}
  <aside class="picker-pane" class:picker-hidden={!pickerOpen} inert={!pickerOpen} aria-hidden={!pickerOpen} aria-label="Choose a OneDrive folder">
    <div class="picker-header"><span>Choose a folder</span><div class="picker-header-actions"><button class="text-action" disabled={busy || pickerStarting} onclick={refreshPicker} aria-label="Refresh folder picker">Refresh</button><button class="text-action" disabled={busy} onclick={() => closePicker()} aria-label="Close folder picker">Close</button></div></div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions: A focusable separator is the accessible window-splitter pattern. -->
    <div class="picker-resize" role="separator" tabindex="0" aria-label="Resize folder picker" aria-orientation="vertical" aria-valuemin="1" aria-valuemax="75" aria-valuenow={Math.round(pickerWidth)} onpointerdown={startResize} onpointermove={moveResize} onlostpointercapture={() => onPickerResizing(false)} onkeydown={resizeWithKeyboard}></div>
    <div class="picker-frames">
      {#each pickerSlots as slot (slot.id)}
        <iframe class="picker-frame" bind:this={slot.frame} class:pending={slot.id !== activePickerId} inert={slot.id !== activePickerId} aria-hidden={slot.id !== activePickerId} title="OneDrive folder picker"></iframe>
      {/each}
    </div>
  </aside>
{/if}
