<script lang="ts">
  import { sizeActionButton } from './lib/size-action-button';
  import { onMount } from 'svelte';
  import CardDialog from './components/CardDialog.svelte';
  import { applyMutation } from './lib/card-mutations';
  import Collection from './components/Collection.svelte';
  import Flashcard from './components/Flashcard.svelte';
  import type { DeckState, MutationRequest, MutationResult } from './lib/types';
  import { advancePractice, filterCards, hideAnswer, moveSession, previousQuestion, reconcileSession, startSession, updateSession } from './lib/session';
  import { createDeckSync } from './lib/deck-sync';

  let deck = $state<DeckState>({ cards: [], files: [], errors: [], revisions: {}, updatedAt: '' });
  let session = $state(startSession([]));
  let selectedSource = $state('');
  let networkError = $state('');
  let dialogAction = $state<'add' | 'edit' | 'remove' | null>(null);
  let loading = $state(true);
  let sync: ReturnType<typeof createDeckSync> | undefined;
  const { order, index, revealed } = $derived(session);
  const current = $derived(order[index]);
  const blocked = $derived(deck.errors.length > 0 || !!networkError);
  const available = $derived(filterCards(deck.cards, selectedSource));
  const remaining = $derived(order.length - index - (revealed ? 1 : 0));
  const remainingWidth = $derived(order.length ? (remaining / order.length) * 100 : 0);

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
    if (!sync) throw new Error('Cannot refresh before deck synchronization is mounted.');
    return sync.refresh();
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
    sync = createDeckSync({
      onDeck: applyDeck,
      onError: message => { networkError = message; },
      onLoading: value => { loading = value; },
    });
    void sync.refresh();
    return sync.close;
  });
</script>

<svelte:window onkeydown={handleKey} />

<div class="shell">
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

  {#if dialogAction}
    <CardDialog action={dialogAction} card={current} {deck} {selectedSource}
      onSaved={applySavedCard} onClose={() => { dialogAction = null; }} />
  {/if}

  {#if order.length && !blocked}
    <div class="remaining-line" role="progressbar" aria-label="Questions remaining in this round"
      aria-valuenow={remaining} aria-valuemin={0} aria-valuemax={order.length}>
      <div style:width={`${remainingWidth}%`}></div>
    </div>
  {/if}
</div>
