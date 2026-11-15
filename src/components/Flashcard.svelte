<script lang="ts">
  import { fade } from 'svelte/transition';
  import { safeHtml } from '../lib/browser-cards';
  import { formatSeenLabel } from '../lib/seen-label';
  import type { Card } from '../lib/types';

  const SEEN_EXPAND_MS = 3000;

  let { card, revealed, hasPrevious, onAction, onHide, onPrevious }: {
    card: Card; revealed: boolean; hasPrevious: boolean;
    onAction: () => void; onHide: () => void; onPrevious: () => void;
  } = $props();

  let seenExpanded = $state(false);
  let seenTimer: ReturnType<typeof setTimeout> | undefined;
  const seenLabel = $derived(formatSeenLabel(card.seen));

  function clearSeenTimer() {
    clearTimeout(seenTimer);
    seenTimer = undefined;
  }

  function expandSeen() {
    seenExpanded = true;
    clearSeenTimer();
    seenTimer = setTimeout(() => {
      seenExpanded = false;
      seenTimer = undefined;
    }, SEEN_EXPAND_MS);
  }

  $effect(() => {
    card.id;
    seenExpanded = false;
    clearSeenTimer();
    return clearSeenTimer;
  });
</script>

<article class="flashcard" class:revealed aria-label="Flashcard">
  <section class="question" aria-labelledby="question-label">
    <header class="question-header">
      <h1 id="question-label" class="section-label">Question</h1>
      <p class="source-annotation">{card.source} · line {card.line}</p>
      <button type="button" class="seen-count" aria-label={seenLabel} onclick={expandSeen}>
        {#if seenExpanded}
          <span transition:fade={{ duration: 150 }}>{seenLabel}</span>
        {:else}
          <span transition:fade={{ duration: 150 }}>{card.seen}</span>
        {/if}
      </button>
    </header>
    <div class="markdown" use:safeHtml={card.questionHtml}></div>
  </section>

  <div class="answer-reveal" aria-hidden={!revealed} inert={!revealed}>
    <div class="answer-clip">
      <section class="answer" aria-labelledby="answer-label">
        <h2 id="answer-label" class="section-label">Answer</h2>
        <div class="markdown" use:safeHtml={card.answerHtml}></div>
      </section>
    </div>
  </div>

  <div class="practice-actions">
    <button class="primary-action" onclick={onAction}>
      <span>{revealed ? 'Next question' : 'Show answer'}</span>
    </button>
    {#if revealed}<button class="text-action" onclick={onHide}>Hide answer</button>{/if}
    <button class="text-action" onclick={onPrevious} disabled={!hasPrevious}>Previous question</button>
  </div>
</article>
