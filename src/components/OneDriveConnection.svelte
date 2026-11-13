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
  import { clampPanelWidth, panelWidthBounds } from '../lib/panel-width';
  import { connectionRetryDeadline, requiresReconnect } from '../lib/mutation-retry';

  let { onBackend, onActivity, onPickerChange, pickerWidth, onPickerWidth, onPickerResizing, viewportWidth, viewportHeight, canSwitch = true }: {
    onBackend: (backend: DeckBackend, name: string) => void; onActivity: (activity: 'connecting' | 'working' | null) => void; onPickerChange: (open: boolean) => void;
    pickerWidth: number; viewportWidth: number; viewportHeight: number; onPickerWidth: (width: number) => void; onPickerResizing: (resizing: boolean) => void;
    canSwitch?: boolean;
  } = $props();
  const clientId = import.meta.env.VITE_ONEDRIVE_CLIENT_ID as string | undefined;
  let auth = $state<OneDriveAuth | undefined>();
  let graph = $state<GraphClient | undefined>();
  let connection: FolderConnection | undefined;
  // Controller snapshots are replaced as a whole; keep backend identity intact.
  let selected = $state.raw<ConnectedFolder | null>(null);
  let busy = $state(false);
  let actionError = $state<Error | null>(null);
  let retryNotBefore = $state<number | null>(null);
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectAttempts = 0;
  const previewParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
  const previewError = previewParams?.get('preview') === 'error'
    ? previewParams.get('error_message') ?? 'Could not connect to OneDrive. Please check your connection and try again.'
    : null;
  const displayedError = $derived(previewError ?? actionError?.message);
  const reconnectNeeded = $derived(previewError !== null || (actionError !== null && requiresReconnect(actionError)));
  const retryDeferred = $derived(retryNotBefore !== null && retryNotBefore > Date.now());
  let redirecting = false;
  let pickerOpen = $state(false);
  const pickerBounds = $derived(viewportWidth > 0 && viewportHeight > 0 ? panelWidthBounds({ width: viewportWidth, height: viewportHeight }) : null);
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
    const wasOpen = pickerOpen;
    removePicker(id);
    if (candidateId === id) { candidateId = undefined; candidateReady = false; pickerStarting = false; clearReadyTimer(); }
    if (activePickerId === id) {
      if (candidateId !== undefined) removePicker(candidateId);
      candidateId = undefined; candidateReady = false; pickerStarting = false; clearReadyTimer();
      activePickerId = null; pickerMounted = false; closePicker();
    }
    if (wasOpen) actionError = failure;
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

  function clearConnectRetry() {
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    connectTimer = undefined;
    retryNotBefore = null;
  }

  function scheduleConnectRetry(notBefore: number, now: number) {
    clearConnectRetry();
    if (destroyed) return;
    const delay = connectAttempts < 3 ? [1000, 2000, 4000][connectAttempts] : 10_000;
    connectAttempts++;
    retryNotBefore = notBefore;
    const retryAt = Math.max(now + delay, notBefore);
    function waitForRetry() {
      const remaining = retryAt - Date.now();
      if (remaining > 0) connectTimer = setTimeout(waitForRetry, Math.min(remaining, 2_147_483_647));
      else void run(restoreConnection, 'connecting');
    }
    waitForRetry();
  }

  function retryConnection() {
    if (retryNotBefore === null || Date.now() < retryNotBefore) return;
    connectAttempts = 0;
    void run(restoreConnection, 'connecting');
  }

  async function run(operation: () => Promise<void>, activity: 'connecting' | 'working' = 'working') {
    if (busy) return;
    busy = true;
    onActivity(activity);
    clearActionError();
    try { await operation(); }
    catch (failure) {
      if (!(failure instanceof OneDriveAuthError || failure instanceof GraphError || failure instanceof DeckRequestError)) throw failure;
      actionError = failure;
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
    onPickerWidth(clampPanelWidth(clientX, { width: viewportWidth, height: viewportHeight }));
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
    const width = (event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().width;
    resizePicker(width + (event.key === 'ArrowRight' ? 2 : -2) / 100 * window.innerWidth);
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
    clearActionError();
    pickerOpen = true;
    onPickerChange(true);
    await preparePicker();
  }

  async function restoreConnection() {
    if (!auth || !clientId) throw new Error('OneDrive authentication was not initialized.');
    graph = createGraphClient(() => auth!.getAccessToken());
    connection = createFolderConnection(graph, createFolderMemory(clientId, () => localStorage), applySelection);
    try { await connection.restore(); }
    catch (failure) {
      const now = Date.now();
      const notBefore = connectionRetryDeadline(failure, now);
      if (notBefore !== null) scheduleConnectRetry(notBefore, now);
      throw failure;
    }
    connectAttempts = 0;
    void preparePicker();
  }

  export async function startConnection() {
    if (!clientId) { actionError = new DeckRequestError("OneDrive isn’t configured for this site."); return; }
    if (selected) { clearActionError(); onBackend(selected.backend, selected.folder.name); return; }
    if (retryNotBefore !== null && Date.now() < retryNotBefore) return;
    await run(async () => {
      if (!auth) throw new Error('OneDrive authentication was not initialized.');
      if (auth.isConnected()) await restoreConnection();
      else await auth.startSignIn();
    }, 'connecting');
  }

  export function reconnect() {
    if (!auth) throw new Error('OneDrive authentication was not initialized.');
    return run(() => auth!.startSignIn());
  }

  export function clearActionError() {
    actionError = null;
    clearConnectRetry();
  }

  onMount(() => {
    if (!clientId) { onActivity(null); return; }
    window.addEventListener('online', retryConnection);
    const restoring = lastProvider() === 'onedrive' || new URLSearchParams(location.search).has('code') || new URLSearchParams(location.search).has('error');
    void run(async () => {
      auth = createOneDriveAuth({ clientId, redirectUri: new URL(import.meta.env.BASE_URL, location.origin).href });
      const returned = await auth!.completeSignIn();
      if (returned) { sessionStorage.removeItem('flashcards.restore.attempted'); await restoreConnection(); }
      else if (lastProvider() === 'onedrive') {
        if (auth!.isConnected()) await restoreConnection();
        else if (!sessionStorage.getItem('flashcards.restore.attempted')) {
          sessionStorage.setItem('flashcards.restore.attempted', '1');
          redirecting = true;
          try { await auth!.startAutomaticSignIn(); }
          catch (error) { redirecting = false; throw error; }
        }
      }
    }, restoring ? 'connecting' : 'working');
    return () => {
      destroyed = true;
      window.removeEventListener('online', retryConnection);
      clearConnectRetry();
      cancelPickerRefresh();
      clearReadyTimer();
      for (const instance of pickers.values()) instance.dispose();
      void connection?.dispose().catch(error => console.error('Could not clear the OneDrive snapshot cache.', error));
    };
  });
</script>

<aside class="onedrive-status" aria-label="OneDrive status" class:has-status={!!displayedError}>
  {#if displayedError}
    <p role="alert" class="save-error">
      {displayedError}
      {#if reconnectNeeded}
        {#if auth || previewError !== null}{' '}<button class="error-action" disabled={!auth || busy || !canSwitch} onclick={reconnect}>Reconnect OneDrive</button>.{/if}
      {:else if retryNotBefore !== null}
        {' '}Retrying…{' '}<button class="error-action" disabled={busy || !canSwitch || retryDeferred} onclick={retryConnection}>Retry</button>.
      {/if}
      {#if graph && !reconnectNeeded}{' '}<button class="error-action" disabled={busy || !canSwitch || retryDeferred} onclick={openPicker}>Choose an existing folder</button>.{/if}
    </p>
  {/if}
</aside>

<style>
  .onedrive-status:not(.has-status) { display: none; }
  .onedrive-status.has-status {
    position: absolute; z-index: 3;
    right: max(30px, env(safe-area-inset-right));
    bottom: max(65px, env(safe-area-inset-bottom));
    max-width: calc(100% - 60px);
    max-height: 40vh; overflow: auto;
    font-size: .78rem; text-align: right; overflow-wrap: anywhere;
  }
  .onedrive-status p { margin: 0; }
  .error-action { border: 0; padding: 0; background: none; color: inherit; font: inherit; text-decoration: underline; }
  @media (max-width: 600px), (orientation: portrait) {
    .onedrive-status.has-status { left: max(20px, env(safe-area-inset-left)); right: auto; text-align: left; }
  }

  .picker-pane { position: fixed; z-index: 0; inset: 0 auto 0 0; width: var(--picker-width); display: flex; flex-direction: column; background: var(--dialog-color, #f9f7f0); visibility: visible; transition: visibility 0s; }
  .picker-hidden { visibility: hidden; pointer-events: none; transition: visibility 0s 300ms; }
  .picker-header { display: flex; justify-content: space-between; align-items: center; padding: .8rem 1rem; }
  .picker-header-actions { display: flex; gap: 1rem; }
  .picker-frames { position: relative; flex: 1; min-height: 0; }
  .picker-pane iframe { position: absolute; inset: 0; border: 0; width: 100%; height: 100%; }
  .picker-pane iframe.pending { opacity: 0; pointer-events: none; }
  .picker-resize { position: absolute; z-index: 1; top: 0; right: -6px; bottom: 0; width: 12px; cursor: col-resize; touch-action: none; }
  .picker-resize:focus-visible { outline: 2px solid #9ca98d; outline-offset: -3px; }
  @media (aspect-ratio < 5/6) {
    .picker-pane { z-index: 10; box-shadow: 2px 0 18px #0003; transform: translateX(0); transition: transform 300ms ease, visibility 0s; }
    .picker-hidden { transform: translateX(-100%); transition: transform 300ms ease, visibility 0s 300ms; }
  }
  @media (prefers-reduced-motion: reduce) { .picker-pane { transition: none; } }
</style>

<svelte:window onkeydown={event => { if (pickerOpen && event.key === 'Escape') closePicker(); }} />
{#if pickerMounted}
  <aside class="picker-pane" class:picker-hidden={!pickerOpen} inert={!pickerOpen} aria-hidden={!pickerOpen} aria-label="Choose a OneDrive folder">
    <div class="picker-header"><span>Choose a folder</span><div class="picker-header-actions"><button class="text-action" disabled={busy || pickerStarting} onclick={refreshPicker} aria-label="Refresh folder picker">Refresh</button><button class="text-action" disabled={busy} onclick={() => closePicker()} aria-label="Close folder picker">Close</button></div></div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions: A focusable separator is the accessible window-splitter pattern. -->
    <div class="picker-resize" role="separator" tabindex="0" aria-label="Resize folder picker" aria-orientation="vertical" aria-valuemin={pickerBounds ? Math.round(pickerBounds.min) : 0} aria-valuemax={pickerBounds ? Math.round(pickerBounds.max) : 0} aria-valuenow={Math.round(pickerWidth)} aria-valuetext={`${Math.round(pickerWidth)} pixels`} onpointerdown={startResize} onpointermove={moveResize} onlostpointercapture={() => onPickerResizing(false)} onkeydown={resizeWithKeyboard}></div>
    <div class="picker-frames">
      {#each pickerSlots as slot (slot.id)}
        <iframe class="picker-frame" bind:this={slot.frame} class:pending={slot.id !== activePickerId} inert={slot.id !== activePickerId} aria-hidden={slot.id !== activePickerId} title="OneDrive folder picker"></iframe>
      {/each}
    </div>
  </aside>
{/if}
