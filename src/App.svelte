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
    }, () => currentBackend.load());
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

  onMount(() => {
    mountLoader();
    return () => loader?.close();
  });
</script>

<svelte:window onkeydown={handleKey} />

<div class="shell" class:has-progress={showProgress}>
  <OneDriveConnection bind:this={oneDriveConnection} onBackend={switchBackend} onBusy={value => { storageBusy = value; }} active={activeStorage} canSwitch={!dialogAction && !loading} />
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
          <p class="section-label" role="status">Loading…</p>
        {:else if !backend}
          <section class="empty-prompt"><p><button disabled={storageBusy || !import.meta.env.VITE_ONEDRIVE_CLIENT_ID} onclick={() => oneDriveConnection.startConnection()}>Connect your cloud storage</button> to start practicing your notes.</p></section>
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
          <button class="text-action" disabled={loading || storageBusy || blocked || !backend} onclick={() => { dialogAction = 'add'; }}>Add</button>
          <button class="text-action" disabled={loading || storageBusy || blocked || !current} onclick={() => { dialogAction = 'remove'; }}>Remove</button>
          <button class="text-action" disabled={loading || storageBusy || blocked || !current} onclick={() => { dialogAction = 'edit'; }}>Edit</button>
          <button class="text-action" disabled={loading || storageBusy || !backend || !!dialogAction} onclick={refresh}>Refresh</button>
        </nav>
      </footer>
    </div>
  </div>

  {#if dialogAction}
    <CardDialog action={dialogAction} card={current} {deck} {selectedSource}
      onSubmit={saveCard} allOccurrences={activeStorage === 'onedrive'} onClose={() => { dialogAction = null; }} />
  {/if}

  {#if showProgress}
    <Progress {remaining} total={order.length} />
  {/if}
</div>
