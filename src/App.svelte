<script lang="ts">
  import { onMount } from 'svelte';
  import CardDialog from './components/CardDialog.svelte';
  import OneDriveConnection from './components/OneDriveConnection.svelte';
  import { fade } from 'svelte/transition';
  import { pickLocalFolder, createLocalFolderBackend, type AccessibleDirectory } from './lib/local-folder';
  import { lastProvider, rememberProvider, rememberLocalFolder } from './lib/storage-memory';
  import { inspectSavedFolder } from './lib/local-folder-restore';
  import { createReadOnlyFolderBackend, readOnlyFolderMessage, selectedFolderName } from './lib/local-folder-readonly';
  import { type DeckBackend } from './lib/deck-backend';
  import Collection from './components/Collection.svelte';
  import Flashcard from './components/Flashcard.svelte';
  import Progress from './components/Progress.svelte';
  import type { DeckState, MutationRequest } from './lib/types';
  import { advancePractice, filterCards, hideAnswer, moveSession, previousQuestion, reconcileSession, startSession, updateSession } from './lib/session';
  import { createDeckLoader, loadTimeoutMessage } from './lib/deck-loader';
  import { DeckRequestError } from './lib/deck-client';
  import HistoryPanel from './components/HistoryPanel.svelte';
  import type { HistoryEntry } from './lib/history';
  import { createMutationQueue, sourceSnapshot, type QueueActivity } from './lib/mutation-queue';
  import type { StoredMutation } from './lib/mutation-storage';
  import { captureOperation } from './lib/onedrive/operations';
  import { projectRecoveredMutation } from './lib/mutation-projection';

  let deck = $state<DeckState>({ cards: [], files: [], errors: [], revisions: {} });
  let session = $state(startSession([]));
  let selectedSource = $state('');
  let failure = $state<{ message: string; source: 'local-picker' | 'deck' } | null>(null);
  const networkError = $derived(failure?.message ?? '');
  let dialogAction = $state<'add' | 'edit' | 'remove' | 'history' | null>(null);
  let history = $state<HistoryEntry[]>([]);
  let pendingItems = $state.raw<StoredMutation[]>([]);
  let activeId = $state<string | null>(null);
  let queueActivity = $state<QueueActivity>(null);
  let matchedIds = $state.raw<string[]>([]);
  let submitting = $state(0);
  let queueProblem = $state('');
  const pendingWrites = $derived(submitting + (activeId ? 1 : 0));
  let blink = $state<'success' | 'failed' | null>(null);
  let blinkTimer: ReturnType<typeof setTimeout> | undefined;
  const hasFailures = $derived(!!queueProblem || history.some(entry => entry.status === 'failed') || pendingItems.some(item => item.review));
  const historyEntries = $derived<HistoryEntry[]>([...pendingItems.map(item => ({
    id: item.id, timestamp: new Date(item.createdAt), action: item.operation.action,
    question: item.operation.action === 'remove' ? item.operation.original!.question : item.operation.replacement.question,
    answer: item.operation.action === 'remove' ? item.operation.original!.answer : item.operation.replacement.answer,
    status: !matchedIds.includes(item.id) ? 'disconnected' as const : item.review ? 'needs-review' as const : activeId === item.id ? queueActivity ?? 'applying' : item.retryAt ? 'waiting' as const : 'queued' as const,
    error: item.error, retryAt: item.retryAt, canDismiss: matchedIds.includes(item.id) && !activeId, canReview: matchedIds.includes(item.id) && !activeId && !item.retryBlocked,
    source: item.operation.source, stage: item.stage, sourceBefore: item.sourceWrite?.before, sourceAfter: item.sourceWrite?.after,
    archiveBefore: item.archiveWrite?.before, archiveAfter: item.archiveWrite?.after,
  })), ...history.filter(entry => !pendingItems.some(item => item.id === entry.id))].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()));
  let loading = $state(true);
  let storageActivity = $state<'connecting' | 'working' | null>(lastProvider() === 'onedrive' || new URLSearchParams(window.location.search).has('code') || new URLSearchParams(window.location.search).has('error') ? 'connecting' : null);
  const storageBusy = $derived(storageActivity !== null);
  const switchingOneDrive = $derived(storageActivity === 'connecting');
  let pickerOpen = $state(false);
  let pickerWidth = $state(0);
  let pickerResizing = $state(false);
  let addWidth = $state(0);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  let addResizing = $state(false);
  const preview = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('preview') : null;
  const addPanelPixels = $derived(Math.min(viewportWidth, viewportWidth / viewportHeight >= 5 / 6
    ? Math.min(viewportWidth * .75, Math.max(viewportHeight * .4, viewportWidth * addWidth / 100))
    : Math.min(viewportWidth, viewportHeight * .4)));
  const cardPanelOpen = $derived(dialogAction === 'add' || dialogAction === 'edit' || dialogAction === 'history');

  function openCardPanel(action: 'add' | 'edit') {
    dialogAction = action;
  }

  function closeCardPanel() {
    dialogAction = null;
  }

  function updateViewport() { viewportWidth = window.innerWidth; viewportHeight = window.innerHeight; }
  function resizeAdd(clientX: number) {
    addWidth = Math.min(75, Math.max(viewportHeight * .4 / viewportWidth * 100, (viewportWidth - clientX) / viewportWidth * 100));
  }

  let backend = $state.raw<DeckBackend | undefined>();
  let readOnly = $state(false);
  let folderName = $state('');
  let provider = $state<'local' | 'onedrive' | null>(null);
  let choosingStorage = $state(false);
  let switchOpen = $state(false);
  let switchTimer: ReturnType<typeof setTimeout> | undefined;
  let storageHeader = $state<HTMLElement>();
  let pointerInStorage = false;
  let oneDrive: OneDriveConnection;
  let writeNotice = $state(false);
  let writeNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  let folderInput: HTMLInputElement;
  let rememberedFolder = $state<AccessibleDirectory>();
  let restoreAttempt = 0;
  const queue = createMutationQueue({
    onChange: (items, active, activity, matched) => {
      if (!blink && items.some(item => item.review && !pendingItems.some(previous => previous.id === item.id && previous.review))) {
        blink = 'failed';
        blinkTimer = setTimeout(() => { blink = null; }, 1600);
      }
      pendingItems = items; activeId = active; queueActivity = activity; matchedIds = matched;
    },
    onError: error => { console.error(error); queueProblem = error instanceof Error ? error.message : String(error); },
    deck: () => $state.snapshot(deck),
    onComplete: async (item, next, resumed, startedAt) => {
      if (!backend) throw new DeckRequestError('Reconnect the original folder to complete this change.');
      const updated = projectRecoveredMutation(deck, item, next, !resumed && startedAt === 'releasing' ? 'source-writing' : startedAt);
      session = updateSession(session, filterCards(updated.cards, selectedSource));
      deck = updated;
      history = [{ id: item.id, timestamp: new Date(item.createdAt), action: item.operation.action,
        question: item.operation.action === 'remove' ? item.operation.original!.question : item.operation.replacement.question,
        answer: item.operation.action === 'remove' ? item.operation.original!.answer : item.operation.replacement.answer, status: 'success' }, ...history.filter(entry => entry.id !== item.id)];
      if (!blink) { blink = 'success'; blinkTimer = setTimeout(() => { blink = null; }, 1600); }
    },
  });

  function showWriteNotice() {
    writeNotice = true;
    clearTimeout(writeNoticeTimer);
    writeNoticeTimer = setTimeout(() => { writeNotice = false; }, 3000);
  }

  function setBackend(next: DeckBackend, readonly: boolean, name: string, source: 'local' | 'onedrive') {
    queue.setBackend(undefined);
    if (source === 'local') oneDrive.clearActionError();
    restoreAttempt++;
    rememberProvider(source);
    provider = source;
    choosingStorage = false;
    switchOpen = false;
    backend = next;
    readOnly = readonly;
    folderName = name;
    writeNotice = false;
    clearTimeout(writeNoticeTimer);
    failure = null;
    deck = { cards: [], files: [], errors: [], revisions: {} };
    session = startSession([]);
    selectedSource = '';
    mountLoader();
  }

  function selectReadOnlyFolder() {
    const files = folderInput.files;
    if (files?.length) setBackend(createReadOnlyFolderBackend(files), true, selectedFolderName(files), 'local');
    folderInput.value = '';
  }
  let loader: ReturnType<typeof createDeckLoader> | undefined;
  const { order, index, revealed } = $derived(session);
  const current = $derived(order[index]);
  const blocked = $derived(deck.errors.length > 0 || !!networkError);
  const available = $derived(filterCards(deck.cards, selectedSource));
  const remaining = $derived(order.length - index - (revealed ? 1 : 0));
  const showProgress = $derived(order.length > 0 && !blocked && !switchingOneDrive);

  function startRound() { session = startSession(available); }
  function performAction() { if (!blocked) session = advancePractice(session); }
  function hideCurrentAnswer() { if (!blocked) session = hideAnswer(session); }
  function showPrevious() { if (!blocked) session = previousQuestion(session); }
  function move(delta: -1 | 1) { if (!blocked) session = moveSession(session, delta); }

  function applyDeck(next: DeckState) {
    if (selectedSource && !next.files.includes(selectedSource)) selectedSource = '';
    session = reconcileSession(session, filterCards(next.cards, selectedSource));
    deck = next;
  }

  async function saveCard(request: MutationRequest) {
    if (loading || storageBusy || !backend) throw new Error('Cannot save without an available card source.');
    if (!backend.persistent) throw new Error('The selected card source cannot persist changes.');
    const snapshot = structuredClone(sourceSnapshot($state.snapshot(deck), request.source));
    const operation = captureOperation(snapshot, request);
    const target = operation.original;
    const entry: HistoryEntry = {
      id: crypto.randomUUID(), timestamp: new Date(), action: request.action,
      question: request.action === 'remove' ? target!.question : request.question,
      answer: request.action === 'remove' ? target!.answer : request.answer, status: 'applying',
    };
    const item: StoredMutation = { id: entry.id, createdAt: entry.timestamp.getTime(), destination: backend.persistent.destination,
      request: { ...request }, operation, snapshot: sourceSnapshot(snapshot, request.source), stage: 'queued', attempts: 0 };
    submitting++;
    try { await queue.enqueue(item); }
    finally { submitting--; }
  }

  function mountLoader(request?: (signal: AbortSignal) => Promise<DeckState>) {
    loader?.close();
    const currentBackend = backend;
    const load = request ?? (currentBackend ? (signal: AbortSignal) => currentBackend.load(signal) : undefined);
    if (!load) { loading = false; loader = undefined; return; }
    loader = createDeckLoader({
      onDeck: next => { applyDeck(next); if (currentBackend === backend && !next.errors.length) queue.setBackend(currentBackend); },
      onError: message => { if (message) failure = { message, source: 'deck' }; else if (failure?.source === 'deck') failure = null; },
      onLoading: value => { loading = value; if (value) queue.setBackend(undefined); },
    }, load);
    void loader.refresh();
  }

  async function connectLocal() {
    try {
      if (!('showDirectoryPicker' in window)) {
        folderInput.click();
        return;
      }
      const selected = await pickLocalFolder();
      setBackend(selected.backend, false, selected.name, 'local');
      try { await rememberLocalFolder(selected.handle); }
      catch (error) {
        if (!(error instanceof DOMException)) throw error;
        failure = { message: `Could not remember the local folder: ${error.message}`, source: 'local-picker' };
      }
    } catch (error) {
      if (error instanceof DeckRequestError && error.cause instanceof DOMException && error.cause.name === 'AbortError') return;
      if (!(error instanceof DeckRequestError)) throw error;
      failure = { message: error.message, source: 'local-picker' };
    }
  }


  function activateLocalFolder(handle: AccessibleDirectory) {
    setBackend(createLocalFolderBackend(handle), false, handle.name, 'local');
  }

  async function restoreLocal() {
    const attempt = ++restoreAttempt;
    try {
      const saved = await inspectSavedFolder();
      if (attempt !== restoreAttempt || !saved) return;
      const { folder: handle, permission } = saved;
      if (permission === 'granted') activateLocalFolder(handle);
      else rememberedFolder = handle;
    } catch (error) {
      if (attempt !== restoreAttempt) return;
      if (!(error instanceof DOMException)) throw error;
      failure = { message: `Could not restore the local folder: ${error.message}`, source: 'local-picker' };
    }
  }
  async function reconnectLocal() {
    if (!rememberedFolder) return;
    const handle = rememberedFolder;
    try {
      const permission = await handle.requestPermission({ mode: 'readwrite' });
      if (permission === 'granted') { rememberedFolder = undefined; activateLocalFolder(handle); }
      else choosingStorage = true;
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      failure = { message: `Could not reconnect the local folder: ${error.message}`, source: 'local-picker' };
    }
  }

  function chooseStorage(source: 'local' | 'onedrive') {
    restoreAttempt++;
    rememberedFolder = undefined;
    switchOpen = false;
    clearTimeout(switchTimer);
    if (source === 'local') { oneDrive.closePicker(false); void connectLocal(); }
    else void oneDrive.startConnection();
  }

  function scheduleSwitchClose() {
    clearTimeout(switchTimer);
    switchTimer = setTimeout(() => { switchOpen = false; }, 1800);
  }

  function dismissSwitch(event: PointerEvent) {
    if (switchOpen && !storageHeader?.contains(event.target as Node)) switchOpen = false;
  }

  function refresh() {
    if (readOnly) { folderInput.click(); return; }
    if (!loader) throw new Error('Cannot refresh before deck loader is mounted.');
    return loader.refresh();
  }

  function handleKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && switchOpen) { switchOpen = false; return; }
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (switchingOneDrive || (dialogAction && dialogAction !== 'history') || event.altKey || event.ctrlKey || event.metaKey || target.closest('button, select, input, a, textarea, summary') || blocked || !current) return;
    if (event.code === 'Space') { event.preventDefault(); performAction(); }
    if (event.key === 'ArrowRight') move(1);
    if (event.key === 'ArrowLeft') showPrevious();
  }

  function defaultPanelWidth(property: string): number {
    const ratio = Number(getComputedStyle(document.documentElement).getPropertyValue(property).trim());
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > .75) throw new Error(`${property} must be a number greater than 0 and at most 0.75.`);
    return ratio * 100;
  }

  onMount(() => {
    void queue.refresh().catch(error => { queueProblem = error instanceof Error ? error.message : String(error); });
    window.addEventListener('online', queue.wake);
    if (lastProvider() === 'local') { choosingStorage = true; if ('showDirectoryPicker' in window) void restoreLocal(); }
    pickerWidth = defaultPanelWidth('--file-selector-default-width-ratio');
    addWidth = defaultPanelWidth('--card-panel-default-width-ratio');
    updateViewport();
    const savedWidth = Number(localStorage.getItem('onedrive-picker-width'));
    if (savedWidth >= 1 && savedWidth <= 75) pickerWidth = savedWidth;
    if (preview === 'connection-error') {
      mountLoader(async () => { throw new DeckRequestError(loadTimeoutMessage); });
    } else if (preview === 'notes-error') {
      mountLoader(async () => ({ cards: [], files: [], errors: ['notes.md:1: Expected an answer after the question.', 'notes.md:7: Found an incomplete flashcard.'], revisions: {} }));
    } else {
      mountLoader();
    }
    return () => { queue.close(); window.removeEventListener('online', queue.wake); loader?.close(); clearTimeout(writeNoticeTimer); clearTimeout(switchTimer); clearTimeout(blinkTimer); };
  });
</script>

<svelte:window onkeydown={handleKey} onresize={updateViewport} onpointerdown={dismissSwitch} />

<div class="shell" class:has-progress={showProgress} class:picker-open={pickerOpen} class:picker-resizing={pickerResizing || addResizing} class:card-panel-open={cardPanelOpen} style:--add-panel-width={addPanelPixels + 'px'} style:--picker-width={pickerWidth + 'vw'}>
  <input type="file" webkitdirectory hidden bind:this={folderInput} onchange={selectReadOnlyFolder} />
  <OneDriveConnection bind:this={oneDrive} active={provider === 'onedrive' ? 'onedrive' : 'local'}
    managedOperations={pendingItems.map(item => item.id)}
    onBackend={(next, name) => setBackend(next, false, name, 'onedrive')}
    onActivity={value => { storageActivity = value; }} onPickerChange={value => { pickerOpen = value; }}
    {pickerWidth} onPickerWidth={value => { pickerWidth = value; localStorage.setItem('onedrive-picker-width', String(value)); }}
    onPickerResizing={value => { pickerResizing = value; }} canSwitch={!loading && !dialogAction && !pendingWrites} />
  {#if backend}
    <aside class="storage-connection" aria-label="Card storage">
      <div class="storage-stack" role="group" aria-label="Storage selection" bind:this={storageHeader} onpointerenter={() => { pointerInStorage = true; clearTimeout(switchTimer); }} onpointerleave={() => { pointerInStorage = false; scheduleSwitchClose(); }}>
      {#if switchOpen}
        <div class="storage-actions storage-switch" transition:fade={{ duration: 150 }}>
          <span class="text-action">Switch storage to:</span>
          <button class="text-action" onclick={() => chooseStorage('local')}>Local</button>
          <button class="text-action" onclick={() => chooseStorage('onedrive')}>OneDrive</button>
        </div>
      {:else}
        <div class="storage-actions" transition:fade={{ duration: 150 }}>
          <button class="text-action" disabled={loading || storageBusy || !!dialogAction || !!pendingWrites} aria-expanded={switchOpen} onclick={() => { switchOpen = true; if (!pointerInStorage) scheduleSwitchClose(); }}>{provider === 'local' ? 'Local' : 'OneDrive'}</button>
          <button class="text-action" disabled={loading || storageBusy || !!dialogAction || !!pendingWrites} onclick={() => provider === 'local' ? connectLocal() : oneDrive.openPicker()}>{folderName}</button>
        </div>
      {/if}
      </div>
    </aside>
  {/if}
  <div class="practice-scroll">
    <div class="practice-page">
      <main class="practice" aria-label="Flashcard practice" aria-busy={loading || switchingOneDrive}>
        {#if switchingOneDrive}
          <section class="empty-prompt"><p role="status">Connecting…</p></section>
        {:else if blocked}
          <div class="practice-errors">
          {#if networkError}
            <section class="empty-prompt connection-error" role="alert">
              <p>Connection Error.<br />{#if networkError === loadTimeoutMessage}{networkError.slice(0, -6)}<button disabled={loading || storageBusy} onclick={failure?.source === 'local-picker' ? connectLocal : refresh}>retry</button>.{:else}{networkError} <button disabled={loading || storageBusy} onclick={failure?.source === 'local-picker' ? connectLocal : refresh}>Retry</button>.{/if}</p>
            </section>
          {/if}
          {#if deck.errors.length > 0}
            <section class="notice" role="alert">
              <h1>Couldn’t read your notes.</h1>
              <div class="notice-errors">
                {#each deck.errors as error}<pre>{error}</pre>{/each}
              </div>
            </section>
          {/if}
          </div>
        {:else if loading}
          <section class="empty-prompt"><p role="status">Loading…</p></section>
        {:else if !backend}
          <section class="empty-prompt">
            {#if storageBusy}
              <p role="status">Connecting…</p>
            {:else}
              <div class="welcome-choices">
                <p class:welcome-hidden={choosingStorage} inert={choosingStorage} aria-hidden={choosingStorage}><button onclick={() => { choosingStorage = true; }}>Connect a storage</button> to start practicing your notes.</p>
                <p class:welcome-hidden={!choosingStorage} inert={!choosingStorage} aria-hidden={!choosingStorage}>{#if rememberedFolder}<button onclick={reconnectLocal}>Reconnect {rememberedFolder.name}</button><br />or<br />{/if}<button onclick={() => chooseStorage('local')}>Local</button><br />or<br /><button onclick={() => chooseStorage('onedrive')}>OneDrive</button></p>
              </div>
            {/if}
          </section>
        {:else if current}
          {#key current.id}
            <Flashcard card={current} {revealed} hasPrevious={index > 0}
              onAction={performAction} onHide={hideCurrentAnswer} onPrevious={showPrevious} />
          {/key}
        {:else}
          <section class="empty-prompt">
            <p>No cards yet.<br />Add question-and-answer pairs to your Markdown notes to start practicing :)</p>
          </section>
        {/if}
      </main>

      <footer class="collection-footer">
        <Collection files={deck.files} total={deck.cards.length} available={available.length}
          bind:source={selectedSource} onChange={startRound} />
        <nav class="card-actions" aria-label="Manage cards">
          {#if writeNotice}
            <span class="text-action write-notice" role="status" transition:fade={{ duration: 150 }}>{readOnlyFolderMessage}</span>
          {:else}
            <div class="card-action-buttons" transition:fade={{ duration: 150 }}>
            <button class="text-action" aria-disabled={readOnly} disabled={loading || storageBusy || blocked || !backend || !!dialogAction} onclick={() => readOnly ? showWriteNotice() : openCardPanel('add')}>Add</button>
            <button class="text-action" aria-disabled={readOnly} disabled={loading || storageBusy || blocked || (!current && !readOnly) || !backend || !!dialogAction} onclick={() => { if (readOnly) showWriteNotice(); else dialogAction = 'remove'; }}>Remove</button>
            <button class="text-action" aria-disabled={readOnly} disabled={loading || storageBusy || blocked || (!current && !readOnly) || !backend || !!dialogAction} onclick={() => readOnly ? showWriteNotice() : openCardPanel('edit')}>Edit</button>
            <button class="text-action" disabled={loading || storageBusy || !backend || !!dialogAction || !!pendingWrites} onclick={refresh}>Refresh</button>
            <button class="text-action history-button" class:has-failures={hasFailures} class:blink-success={blink === 'success'} class:blink-failed={blink === 'failed'} disabled={!!dialogAction} onclick={() => { dialogAction = 'history'; }}>History</button>
            </div>
          {/if}
        </nav>
      </footer>
    </div>
  </div>

  {#if dialogAction === 'history'}
    <HistoryPanel history={historyEntries} problem={queueProblem} {addWidth} onResizeAdd={resizeAdd} onAddResizing={value => { addResizing = value; }} onClose={closeCardPanel} onReview={id => {
      void queue.reviewAgain(id).catch(error => { queueProblem = error instanceof Error ? error.message : String(error); });
    }} onDismiss={id => {
      if (pendingItems.some(item => item.id === id)) void queue.discard(id).catch(error => { queueProblem = error instanceof Error ? error.message : String(error); });
      else history = history.filter(entry => entry.id !== id);
    }} />
  {:else if dialogAction}
    <CardDialog action={dialogAction} card={current} {deck} {selectedSource}
      onSubmit={saveCard} {pickerOpen} {addWidth} onResizeAdd={resizeAdd} onAddResizing={value => { addResizing = value; }} allOccurrences={true} onClose={closeCardPanel} />
  {/if}

  {#if showProgress}
    <Progress {remaining} total={order.length} />
  {/if}
</div>
