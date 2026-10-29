<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { Card, DeckState, MutationRequest } from '../lib/types';
  import FilePicker from './FilePicker.svelte';
  import { sizeActionButton } from '../lib/size-action-button';
  import { resizeTextarea } from '../lib/resize-textarea';
  import { cardPosition } from '../lib/card-mutations';
  import { resolveSource, sourceLabel } from '../lib/source-names';
  import { DeckRequestError } from '../lib/deck-client';

  let { action, card, deck, selectedSource, onSubmit, onClose, pickerOpen, addWidth, onResizeAdd, onAddResizing, allOccurrences = false }: {
    action: 'add' | 'edit' | 'remove'; card: Card | undefined; deck: DeckState; selectedSource: string;
    onSubmit: (request: MutationRequest) => Promise<void>; onClose: () => void; pickerOpen: boolean; addWidth: number; onResizeAdd: (clientX: number) => void; onAddResizing: (value: boolean) => void; allOccurrences?: boolean;
  } = $props();
  // The current practice card may disappear while an asynchronous Remove
  // completes. The dialog owns the card snapshot it was opened for.
  const targetCard = untrack(() => card);
  const initial = untrack(() => {
    if (action !== 'add' && !targetCard) throw new Error('Edit and Remove require a current card.');
    return { question: action === 'add' ? '' : targetCard!.question, answer: action === 'add' ? '' : targetCard!.answer, source: selectedSource || 'default.md' };
  });
  let dialog = $state<HTMLDialogElement>(undefined!);
  let panel = $state<HTMLElement>(undefined!);
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
    if (action !== 'remove') {
      panel.querySelector<HTMLElement>(action === 'add' ? 'input' : 'textarea')?.focus();
      return () => { if (previous instanceof HTMLElement) previous.focus(); };
    }
    dialog.showModal();
    return () => { dialog.close(); if (previous instanceof HTMLElement) previous.focus(); };
  });
</script>

{#snippet cardForm()}
  <form onsubmit={save} aria-busy={busy}>
    {#if action !== 'remove'}<h2 id="card-dialog-title">{action === 'add' ? 'Add card' : 'Edit card'}</h2>{/if}
    {#if allOccurrences && action === 'edit'}<p>Applies to every identical question-and-answer pair in this file.</p>{/if}
    {#if action === 'remove'}
      <div class="remove-confirmation">
        <p id="card-dialog-title">Remove this card from <em>{sourceLabel(targetCard!.source)}</em>?</p>
        {#if allOccurrences}<blockquote><p>This applies to every identical question-and-answer pair in this file.</p></blockquote>{/if}
        <blockquote><p>You can restore it later from <code>removed.md</code>.</p></blockquote>
      </div>
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
{/snippet}

<svelte:window onkeydown={event => { if (action !== 'remove' && event.key === 'Escape' && !event.defaultPrevented) close(); }} />
{#if action !== 'remove'}
  <aside class="add-panel" bind:this={panel} aria-labelledby="card-dialog-title">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions: Keyboard-accessible window splitter. -->
    <div class="add-panel-resize" role="separator" tabindex="0" aria-label={action === 'add' ? 'Resize add panel' : 'Resize edit panel'} aria-orientation="vertical" aria-valuemin="1" aria-valuemax="75" aria-valuenow={Math.round(addWidth)}
      onpointerdown={event => { if (event.button === 0) { event.currentTarget.setPointerCapture(event.pointerId); onAddResizing(true); onResizeAdd(event.clientX); } }}
      onpointermove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onResizeAdd(event.clientX); }}
      onlostpointercapture={() => onAddResizing(false)}
      onkeydown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onResizeAdd(window.innerWidth * (1 - (addWidth + (event.key === 'ArrowLeft' ? 2 : -2)) / 100)); } }}></div>
    <div class="add-panel-content">{@render cardForm()}</div>
  </aside>
{:else}
<dialog bind:this={dialog} class:remove-banner={action === 'remove'} class:picker-open={pickerOpen} aria-labelledby="card-dialog-title" oncancel={event => { event.preventDefault(); close(); }}>
  {@render cardForm()}
</dialog>
{/if}
