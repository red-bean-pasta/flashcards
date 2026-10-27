<script lang="ts">
  import { sizeActionButton } from './lib/size-action-button';
  import { onMount } from 'svelte';
  import CardDialog from './components/CardDialog.svelte';
  import { applyMutation } from './lib/card-mutations';
  import Collection from './components/Collection.svelte';
  import Flashcard from './components/Flashcard.svelte';
  import Progress from './components/Progress.svelte';
  import type { DeckState, MutationRequest, MutationResult } from './lib/types';
  import { advancePractice, filterCards, hideAnswer, moveSession, previousQuestion, reconcileSession, startSession, updateSession } from './lib/session';
  import { createDeckLoader } from './lib/deck-loader';

  let deck = $state<DeckState>({ cards: [], files: [], errors: [], revisions: {} });
  let session = $state(startSession([]));
  let selectedSource = $state('');
  let networkError = $state('');
  let dialogAction = $state<'add' | 'edit' | 'remove' | null>(null);
  let loading = $state(true);
  let loader: ReturnType<typeof createDeckLoader> | undefined;
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

  function applySavedCard(request: MutationRequest, result: MutationResult) {
    const next = applyMutation(deck, request, result);
    session = updateSession(session, filterCards(next.cards, selectedSource));
    deck = next;
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
    loader = createDeckLoader({
      onDeck: applyDeck,
      onError: message => { networkError = message; },
      onLoading: value => { loading = value; },
    });
    void loader.refresh();
    return loader.close;
  });
</script>

<svelte:window onkeydown={handleKey} />

<div class="shell" class:has-progress={showProgress}>
  <div class="practice-scroll">
    <div class="practice-page">
      <main class="practice" aria-label="Flashcard practice" aria-busy={loading}>
        {#if blocked}
          <section class="notice" role="alert">
            <h1 class="section-label">{networkError ? 'Connection error' : 'Check your notes'}</h1>
            {#each deck.errors as error}<pre>{error}</pre>{/each}
            {#if networkError}<p>{networkError}</p><button use:sizeActionButton class="primary-action" onclick={refresh}><span>Retry</span></button>{/if}
          </section>
        {:else if loading}
          <p class="section-label" role="status">Loading…</p>
        {:else if current}
          {#key current.id}
            <Flashcard card={current} {revealed} hasPrevious={index > 0}
              onAction={performAction} onHide={hideCurrentAnswer} onPrevious={showPrevious} />
          {/key}
        {:else}
          <section class="notice">
            <h1 class="section-label">No cards yet</h1>
            <p>Add <code># question</code> and <code># answer</code> sections to your Markdown notes.</p>
          </section>
        {/if}
      </main>

      <footer class="collection-footer">
        <Collection files={deck.files} total={deck.cards.length} available={available.length}
          bind:source={selectedSource} onChange={startRound} />
        <nav class="card-actions" aria-label="Manage cards">
          <button class="text-action" disabled={loading || blocked} onclick={() => { dialogAction = 'add'; }}>Add</button>
          <button class="text-action" disabled={loading || blocked || !current} onclick={() => { dialogAction = 'remove'; }}>Remove</button>
          <button class="text-action" disabled={loading || blocked || !current} onclick={() => { dialogAction = 'edit'; }}>Edit</button>
        </nav>
      </footer>
    </div>
  </div>

  {#if dialogAction}
    <CardDialog action={dialogAction} card={current} {deck} {selectedSource}
      onSaved={applySavedCard} onClose={() => { dialogAction = null; }} />
  {/if}

  {#if showProgress}
    <Progress {remaining} total={order.length} />
  {/if}
</div>
