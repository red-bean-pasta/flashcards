<script lang="ts">
  import { onMount } from 'svelte';
  import Collection from './components/Collection.svelte';
  import Flashcard from './components/Flashcard.svelte';
  import type { DeckState } from './lib/types';
  import { advancePractice, filterCards, hideAnswer, moveSession, previousQuestion, reconcileSession, startSession } from './lib/session';
  import { createDeckSync } from './lib/deck-sync';

  let deck = $state<DeckState>({ cards: [], files: [], errors: [], updatedAt: '' });
  let session = $state(startSession([]));
  let selectedSource = $state('');
  let networkError = $state('');
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

  function refresh() {
    if (!sync) throw new Error('Cannot refresh before deck synchronization is mounted.');
    return sync.refresh();
  }

  function handleKey(event: KeyboardEvent) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || target.closest('button, select, input, a, textarea') || blocked || !current) return;
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
        {#if networkError}<p>{networkError}</p><button class="primary-action" onclick={refresh}>Retry</button>{/if}
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
  </footer>

  {#if order.length && !blocked}
    <div class="remaining-line" role="progressbar" aria-label="Questions remaining in this round"
      aria-valuenow={remaining} aria-valuemin={0} aria-valuemax={order.length}>
      <div style:width={`${remainingWidth}%`}></div>
    </div>
  {/if}
</div>
