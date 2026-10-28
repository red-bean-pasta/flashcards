<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { Card, DeckState, MutationRequest } from '../lib/types';
  import FilePicker from './FilePicker.svelte';
  import { sizeActionButton } from '../lib/size-action-button';
  import { resizeTextarea } from '../lib/resize-textarea';
  import { cardPosition } from '../lib/card-mutations';
  import { resolveSource, sourceLabel } from '../lib/source-names';
  import { DeckRequestError } from '../lib/deck-client';

  let { action, card, deck, selectedSource, onSubmit, onClose, allOccurrences = false }: {
    action: 'add' | 'edit' | 'remove'; card: Card | undefined; deck: DeckState; selectedSource: string;
    onSubmit: (request: MutationRequest) => Promise<void>; onClose: () => void; allOccurrences?: boolean;
  } = $props();
  // The current practice card may disappear while an asynchronous Remove
  // completes. The dialog owns the card snapshot it was opened for.
  const targetCard = untrack(() => card);
  const initial = untrack(() => {
    if (action !== 'add' && !targetCard) throw new Error('Edit and Remove require a current card.');
    return { question: action === 'add' ? '' : targetCard!.question, answer: action === 'add' ? '' : targetCard!.answer, source: selectedSource || 'default.md' };
  });
  let dialog: HTMLDialogElement;
  let question = $state(initial.question);
  let answer = $state(initial.answer);
  let fileInput = $state(sourceLabel(initial.source));
  let chosenSource = $state(initial.source);
  let busy = $state(false);
  let error = $state('');
  const destination = $derived(resolveSource(deck.files, fileInput, chosenSource));

  function close() { if (!busy) onClose(); }

  function buildRequest(): MutationRequest | undefined {
    if (action === 'remove') return { action, source: targetCard!.source, revision: deck.revisions[targetCard!.source], index: cardPosition(deck, targetCard!) };
    if (!question.trim() || !answer.trim()) { error = 'Question and answer are required.'; return; }
    if (action === 'edit') return { action, source: targetCard!.source, revision: deck.revisions[targetCard!.source], index: cardPosition(deck, targetCard!), question, answer };
    if (destination.error) { error = destination.error; return; }
    const source = destination.source;
    return { action, source, revision: deck.revisions[source] ?? null, question, answer };
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    error = '';
    const request = buildRequest();
    if (!request) return;
    busy = true;
    try {
      await onSubmit(request);
      onClose();
    } catch (failure) {
      if (!(failure instanceof DeckRequestError)) throw failure;
      error = failure.message;
    } finally { busy = false; }
  }

  onMount(() => {
    const previous = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previous instanceof HTMLElement) previous.focus(); };
  });
</script>

<dialog bind:this={dialog} aria-labelledby="card-dialog-title" oncancel={event => { event.preventDefault(); close(); }}>
  <form onsubmit={save} aria-busy={busy}>
    <h2 id="card-dialog-title">{action === 'add' ? 'Add card' : action === 'edit' ? 'Edit card' : 'Confirm removal'}</h2>
    {#if allOccurrences && action !== 'add'}<p>Applies to every identical question-and-answer pair in this file.</p>{/if}
    {#if action === 'remove'}
      <p class="remove-confirmation">Remove card <em class="remove-question">“{targetCard!.question}”</em> from <em>{sourceLabel(targetCard!.source)}</em>?</p>
      <blockquote class="recovery-note">You can restore it later from <code>removed.md</code>.</blockquote>
    {:else}
      {#if action === 'add'}
        <FilePicker files={deck.files} bind:text={fileInput} bind:chosen={chosenSource} disabled={busy} />
        {#if destination.create}<p class="file-hint">Create {destination.source}</p>{/if}
      {/if}
      <label for="card-question">Question</label>
      <textarea use:resizeTextarea id="card-question" rows="3" bind:value={question} disabled={busy} required></textarea>
      <label for="card-answer">Answer</label>
      <textarea use:resizeTextarea id="card-answer" rows="8" bind:value={answer} disabled={busy} required></textarea>
    {/if}
    {#if error}<p role="alert" class="save-error">{error}</p>{/if}
    <div class="dialog-actions">
      <button type="button" class="text-action" onclick={close} disabled={busy}>Cancel</button>
      <button use:sizeActionButton type="submit" class="primary-action" disabled={busy}><span>{busy ? 'Saving…' : action === 'remove' ? 'Remove' : 'Save'}</span></button>
    </div>
  </form>
</dialog>
