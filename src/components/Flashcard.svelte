<script lang="ts">
  import type { Card } from '../lib/types';
  let { card, revealed, hasPrevious, onAction, onHide, onPrevious }: {
    card: Card; revealed: boolean; hasPrevious: boolean;
    onAction: () => void; onHide: () => void; onPrevious: () => void;
  } = $props();
</script>

<article class="flashcard" class:revealed aria-label="Flashcard">
  <section class="question" aria-labelledby="question-label">
    <header class="question-header">
      <h1 id="question-label" class="section-label">Question</h1>
      <p class="source-annotation">{card.source} · line {card.line}</p>
    </header>
    <div class="markdown">{@html card.questionHtml}</div>
  </section>

  <div class="answer-reveal" aria-hidden={!revealed} inert={!revealed}>
    <div class="answer-clip">
      <section class="answer" aria-labelledby="answer-label">
        <h2 id="answer-label" class="section-label">Answer</h2>
        <div class="markdown">{@html card.answerHtml}</div>
      </section>
    </div>
  </div>

  <div class="practice-actions">
    <button class="primary-action" onclick={onAction}>
      {revealed ? 'Next question' : 'Show answer'}
    </button>
    {#if revealed}<button class="text-action" onclick={onHide}>Hide answer</button>{/if}
    <button class="text-action" onclick={onPrevious} disabled={!hasPrevious}>Previous question</button>
  </div>
</article>
