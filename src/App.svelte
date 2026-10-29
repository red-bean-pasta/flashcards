<script lang="ts">
  import { sizeActionButton } from './lib/size-action-button';
  import { onMount } from 'svelte';
  import CardDialog from './components/CardDialog.svelte';
  import OneDriveConnection from './components/OneDriveConnection.svelte';
  import { localBackend, type DeckBackend } from './lib/deck-backend';
  import Collection from './components/Collection.svelte';
  import Flashcard from './components/Flashcard.svelte';
  import Progress from './components/Progress.svelte';
  import type { DeckState, MutationRequest } from './lib/types';
  import { advancePractice, filterCards, hideAnswer, moveSession, previousQuestion, reconcileSession, startSession, updateSession } from './lib/session';
  import { createDeckLoader } from './lib/deck-loader';

  let deck = $state<DeckState>({ cards: [], files: [], errors: [], revisions: {} });
  let session = $state(startSession([]));
  let selectedSource = $state('');
  let networkError = $state('');
  let dialogAction = $state<'add' | 'edit' | 'remove' | null>(null);
  let loading = $state(true);
  let storageBusy = $state(false);
  let pickerOpen = $state(false);
  let pickerWidth = $state(0);
  let pickerResizing = $state(false);
  let addWidth = $state(0);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  let addResizing = $state(false);
  let restorePicker = false;
  const addPanelPixels = $derived(Math.min(viewportWidth, viewportWidth / viewportHeight >= 5 / 6
    ? Math.min(viewportWidth * .75, Math.max(viewportHeight * .4, viewportWidth * addWidth / 100))
    : Math.min(viewportWidth, viewportHeight * .4)));
  const cardPanelOpen = $derived(dialogAction === 'add' || dialogAction === 'edit');

  function openCardPanel(action: 'add' | 'edit') {
    restorePicker = pickerOpen && window.matchMedia('(min-aspect-ratio: 5/6)').matches;
    oneDriveConnection.closePicker(false);
    dialogAction = action;
  }

  function closeCardPanel() {
    dialogAction = null;
    if (restorePicker && window.matchMedia('(min-aspect-ratio: 5/6)').matches) void oneDriveConnection.openPicker();
    restorePicker = false;
  }

  function updateViewport() { viewportWidth = window.innerWidth; viewportHeight = window.innerHeight; }
  function resizeAdd(clientX: number) {
    addWidth = Math.min(75, Math.max(viewportHeight * .4 / viewportWidth * 100, (viewportWidth - clientX) / viewportWidth * 100));
  }

  function updatePickerWidth(width: number) {
    pickerWidth = width;
    localStorage.setItem('onedrive-picker-width', String(width));
  }
  let activeStorage = $state<'local' | 'onedrive'>(import.meta.env.VITE_DEFAULT_STORAGE === 'onedrive' ? 'onedrive' : 'local');
  let backend = $state<DeckBackend | undefined>(import.meta.env.VITE_DEFAULT_STORAGE === 'onedrive' ? undefined : localBackend);
  let loader: ReturnType<typeof createDeckLoader> | undefined;
  let oneDriveConnection: ReturnType<typeof OneDriveConnection>;
  const { order, index, revealed } = $derived(session);
  const current = $derived(order[index]);
  const blocked = $derived(deck.errors.length > 0 || !!networkError);
  const available = $derived(filterCards(deck.cards, selectedSource));
  const remaining = $derived(order.length - index - (revealed ? 1 : 0));
  const showProgress = $derived(order.length > 0 && !blocked);

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

  function mountLoader() {
    loader?.close();
    if (!backend) { loading = false; return; }
    const currentBackend = backend;
    loader = createDeckLoader({
      onDeck: applyDeck,
      onError: message => { networkError = message; },
      onLoading: value => { loading = value; },
    }, signal => currentBackend.load(signal));
    void loader.refresh();
  }

  function switchBackend(next: DeckBackend | null) {
    backend = next ?? (import.meta.env.VITE_DEFAULT_STORAGE === 'onedrive' ? undefined : localBackend);
    activeStorage = next ? 'onedrive' : (import.meta.env.VITE_DEFAULT_STORAGE === 'onedrive' ? 'onedrive' : 'local');
    deck = { cards: [], files: [], errors: [], revisions: {} };
    session = startSession([]);
    selectedSource = '';
    networkError = '';
    mountLoader();
  }

  function refresh() {
    if (!loader) throw new Error('Cannot refresh before deck loader is mounted.');
    return loader.refresh();
  }

  function handleKey(event: KeyboardEvent) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (dialogAction || event.altKey || event.ctrlKey || event.metaKey || target.closest('button, select, input, a, textarea') || blocked || !current) return;
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
    mountLoader();
    return () => loader?.close();
  });
</script>

<svelte:window onkeydown={handleKey} onresize={updateViewport} />

<div class="shell" class:has-progress={showProgress} class:picker-open={pickerOpen} class:picker-resizing={pickerResizing || addResizing} class:card-panel-open={cardPanelOpen} style:--add-panel-width={addPanelPixels + 'px'} style:--picker-width={pickerWidth + 'vw'}>
  <OneDriveConnection bind:this={oneDriveConnection} onBackend={switchBackend} onBusy={value => { storageBusy = value; }} onPickerChange={value => { pickerOpen = value; }} {pickerWidth} onPickerWidth={updatePickerWidth} onPickerResizing={value => { pickerResizing = value; }} active={activeStorage} canSwitch={!dialogAction} />
  <div class="practice-scroll">
    <div class="practice-page">
      <main class="practice" aria-label="Flashcard practice" aria-busy={loading}>
        {#if blocked}
          <section class="notice" role="alert">
            <h1 class="section-label">{networkError ? 'Connection error' : 'Check your notes'}</h1>
            {#each deck.errors as error}<pre>{error}</pre>{/each}
            {#if networkError}<p>{networkError}</p><button use:sizeActionButton class="primary-action" disabled={loading || storageBusy} onclick={refresh}><span>Retry</span></button>{/if}
          </section>
        {:else if loading}
          <section class="empty-prompt"><p role="status">Loading…</p></section>
        {:else if !backend}
          <section class="empty-prompt">
            {#if storageBusy}
              <p role="status">Connecting…</p>
            {:else}
              <p><button disabled={!import.meta.env.VITE_ONEDRIVE_CLIENT_ID} onclick={() => oneDriveConnection.startConnection()}>Connect your cloud storage</button> to start practicing your notes.</p>
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
          <button class="text-action" disabled={loading || storageBusy || blocked || !backend || !!dialogAction} onclick={() => openCardPanel('add')}>Add</button>
          <button class="text-action" disabled={loading || storageBusy || blocked || !current || !!dialogAction} onclick={() => { dialogAction = 'remove'; }}>Remove</button>
          <button class="text-action" disabled={loading || storageBusy || blocked || !current || !!dialogAction} onclick={() => openCardPanel('edit')}>Edit</button>
          <button class="text-action" disabled={loading || storageBusy || !backend || !!dialogAction} onclick={refresh}>Refresh</button>
        </nav>
      </footer>
    </div>
  </div>

  {#if dialogAction}
    <CardDialog action={dialogAction} card={current} {deck} {selectedSource}
      onSubmit={saveCard} {pickerOpen} {addWidth} onResizeAdd={resizeAdd} onAddResizing={value => { addResizing = value; }} allOccurrences={activeStorage === 'onedrive'} onClose={closeCardPanel} />
  {/if}

  {#if showProgress}
    <Progress {remaining} total={order.length} />
  {/if}
</div>
