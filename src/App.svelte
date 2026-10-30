<script lang="ts">
  import { onMount } from 'svelte';
  import CardDialog from './components/CardDialog.svelte';
  import OneDriveConnection from './components/OneDriveConnection.svelte';
  import { fade } from 'svelte/transition';
  import { pickLocalFolder } from './lib/local-folder';
  import { createReadOnlyFolderBackend, selectedFolderName } from './lib/local-folder-readonly';
  import { type DeckBackend } from './lib/deck-backend';
  import Collection from './components/Collection.svelte';
  import Flashcard from './components/Flashcard.svelte';
  import Progress from './components/Progress.svelte';
  import type { DeckState, MutationRequest } from './lib/types';
  import { advancePractice, filterCards, hideAnswer, moveSession, previousQuestion, reconcileSession, startSession, updateSession } from './lib/session';
  import { createDeckLoader, loadTimeoutMessage } from './lib/deck-loader';
  import { DeckRequestError } from './lib/deck-client';

  let deck = $state<DeckState>({ cards: [], files: [], errors: [], revisions: {} });
  let session = $state(startSession([]));
  let selectedSource = $state('');
  let failure = $state<{ message: string; source: 'local-picker' | 'deck' } | null>(null);
  const networkError = $derived(failure?.message ?? '');
  let dialogAction = $state<'add' | 'edit' | 'remove' | null>(null);
  let loading = $state(true);
  let storageActivity = $state<'connecting' | 'working' | null>(null);
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
  const cardPanelOpen = $derived(dialogAction === 'add' || dialogAction === 'edit');

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

  let backend = $state<DeckBackend | undefined>();
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

  function showWriteNotice() {
    writeNotice = true;
    clearTimeout(writeNoticeTimer);
    writeNoticeTimer = setTimeout(() => { writeNotice = false; }, 3000);
  }

  function setBackend(next: DeckBackend, readonly: boolean, name: string, source: 'local' | 'onedrive') {
    if (source === 'local') oneDrive.clearActionError();
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
    if (loading || storageBusy) throw new Error('Cannot save while the card source is busy.');
    if (!backend) throw new Error('Saving requires a connected card source.');
    const savingBackend = backend;
    const next = await savingBackend.mutate(request, deck);
    if (backend !== savingBackend) throw new Error('Card source changed during an active mutation.');
    session = updateSession(session, filterCards(next.cards, selectedSource));
    deck = next;
  }

  function mountLoader(request?: (signal: AbortSignal) => Promise<DeckState>) {
    loader?.close();
    const currentBackend = backend;
    const load = request ?? (currentBackend ? (signal: AbortSignal) => currentBackend.load(signal) : undefined);
    if (!load) { loading = false; loader = undefined; return; }
    loader = createDeckLoader({
      onDeck: applyDeck,
      onError: message => { if (message) failure = { message, source: 'deck' }; else if (failure?.source === 'deck') failure = null; },
      onLoading: value => { loading = value; },
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
    } catch (error) {
      if (error instanceof DeckRequestError && error.cause instanceof DOMException && error.cause.name === 'AbortError') return;
      if (!(error instanceof DeckRequestError)) throw error;
      failure = { message: error.message, source: 'local-picker' };
    }
  }

  function chooseStorage(source: 'local' | 'onedrive') {
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
    if (switchingOneDrive || dialogAction || event.altKey || event.ctrlKey || event.metaKey || target.closest('button, select, input, a, textarea') || blocked || !current) return;
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
    return () => { loader?.close(); clearTimeout(writeNoticeTimer); clearTimeout(switchTimer); };
  });
</script>

<svelte:window onkeydown={handleKey} onresize={updateViewport} onpointerdown={dismissSwitch} />

<div class="shell" class:has-progress={showProgress} class:picker-open={pickerOpen} class:picker-resizing={pickerResizing || addResizing} class:card-panel-open={cardPanelOpen} style:--add-panel-width={addPanelPixels + 'px'} style:--picker-width={pickerWidth + 'vw'}>
  <input type="file" webkitdirectory hidden bind:this={folderInput} onchange={selectReadOnlyFolder} />
  <OneDriveConnection bind:this={oneDrive} active={provider === 'onedrive' ? 'onedrive' : 'local'}
    onBackend={(next, name) => setBackend(next, false, name, 'onedrive')}
    onActivity={value => { storageActivity = value; }} onPickerChange={value => { pickerOpen = value; }}
    {pickerWidth} onPickerWidth={value => { pickerWidth = value; localStorage.setItem('onedrive-picker-width', String(value)); }}
    onPickerResizing={value => { pickerResizing = value; }} canSwitch={!loading && !dialogAction} />
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
          <button class="text-action" disabled={loading || storageBusy || !!dialogAction} aria-expanded={switchOpen} onclick={() => { switchOpen = true; if (!pointerInStorage) scheduleSwitchClose(); }}>{provider === 'local' ? 'Local' : 'OneDrive'}</button>
          <button class="text-action" disabled={loading || storageBusy || !!dialogAction} onclick={() => provider === 'local' ? connectLocal() : oneDrive.openPicker()}>{folderName}</button>
        </div>
      {/if}
      </div>
    </aside>
  {/if}
  <div class="practice-scroll">
    <div class="practice-page">
      <main class="practice" aria-label="Flashcard practice" aria-busy={loading || switchingOneDrive}>
        {#if switchingOneDrive}
          <section class="empty-prompt"><p role="status">Loading…</p></section>
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
                <p class:welcome-hidden={!choosingStorage} inert={!choosingStorage} aria-hidden={!choosingStorage}><button onclick={() => chooseStorage('local')}>Local</button><br />or<br /><button onclick={() => chooseStorage('onedrive')}>OneDrive</button></p>
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
            <span class="text-action write-notice" role="status" transition:fade={{ duration: 150 }}>Your browser does not support write to local storage</span>
          {:else}
            <div class="card-action-buttons" transition:fade={{ duration: 150 }}>
            <button class="text-action" aria-disabled={readOnly} disabled={loading || storageBusy || blocked || !backend || !!dialogAction} onclick={() => readOnly ? showWriteNotice() : openCardPanel('add')}>Add</button>
            <button class="text-action" aria-disabled={readOnly} disabled={loading || storageBusy || blocked || (!current && !readOnly) || !backend || !!dialogAction} onclick={() => { if (readOnly) showWriteNotice(); else dialogAction = 'remove'; }}>Remove</button>
            <button class="text-action" aria-disabled={readOnly} disabled={loading || storageBusy || blocked || (!current && !readOnly) || !backend || !!dialogAction} onclick={() => readOnly ? showWriteNotice() : openCardPanel('edit')}>Edit</button>
            <button class="text-action" disabled={loading || storageBusy || !backend || !!dialogAction} onclick={refresh}>Refresh</button>
            </div>
          {/if}
        </nav>
      </footer>
    </div>
  </div>

  {#if dialogAction}
    <CardDialog action={dialogAction} card={current} {deck} {selectedSource}
      onSubmit={saveCard} {pickerOpen} {addWidth} onResizeAdd={resizeAdd} onAddResizing={value => { addResizing = value; }} allOccurrences={true} onClose={closeCardPanel} />
  {/if}

  {#if showProgress}
    <Progress {remaining} total={order.length} />
  {/if}
</div>
