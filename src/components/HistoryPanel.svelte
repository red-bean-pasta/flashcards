<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import type { HistoryEntry } from '../lib/history';
  import { panelTransition } from '../lib/panel-transition';

  let { history, problem = '', resizeHandle, onClose, onDismiss, onReview, onReconnect }: {
    history: HistoryEntry[]; resizeHandle: Snippet<[string]>;
    problem?: string; onClose: () => void; onDismiss: (id: string) => void; onReview: (id: string) => void;
    onReconnect: () => void;
  } = $props();
  let panel: HTMLElement;
  let now = $state(Date.now());
  function countdown(deadline: number) {
    const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
    return `Retry after ${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  }
  onMount(() => {
    const previous = document.activeElement;
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    panel.querySelector<HTMLButtonElement>('.history-close')?.focus();
    return () => { clearInterval(timer); if (panel.contains(document.activeElement) && previous instanceof HTMLElement) previous.focus(); };
  });
</script>

<svelte:window onpointerdown={event => { const target = event.target; if (target instanceof Node && !panel.contains(target) && !(target instanceof Element && target.closest('button'))) onClose(); }} onkeydown={event => { if (event.key === 'Escape' && !event.defaultPrevented) onClose(); }} />
<aside class="add-panel" transition:panelTransition|global={{ axis: 'X', duration: 300 }} bind:this={panel} aria-labelledby="history-title">
  {@render resizeHandle('Resize history panel')}
  <div class="add-panel-content history-panel">
    <div class="history-heading"><h2 id="history-title">History</h2><button class="text-action history-close" onclick={onClose}>Close</button></div>
    {#if problem}<p class="history-error" role="alert">{problem}</p>{/if}
    {#if history.length === 0}<p>No changes yet.</p>{/if}
    <div class="history-list">
      {#each history as entry (entry.id)}
        <article class="history-entry">
          <time class="history-timestamp" datetime={entry.timestamp.toISOString()}>{entry.timestamp.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
          <strong>{entry.action[0].toUpperCase() + entry.action.slice(1)}</strong>
          <details><summary><span class="history-collapsed">{entry.question.replace(/\s+/g, ' ').trim()}</span><pre class="history-expanded"># question
{entry.question}

# answer
{entry.answer}</pre></summary></details>
          {#if entry.status === 'needs-review'}
            <p class="history-status failed">
              Review Required:{' '}
              {#if entry.reconnect}
                <button class="text-action" onclick={onReconnect}>Reconnect</button> OneDrive to continue.
              {:else if entry.error}
                {entry.error}
              {:else}
                Review the files manually before dismissing.
              {/if}
            </p>
            <p class="history-actions">
              {#if entry.canReview}<button class="text-action" onclick={() => onReview(entry.id)}>Retry</button>{' '}or{/if}
              {#if entry.canDismiss}{' '}<button class="text-action" onclick={() => onDismiss(entry.id)}>keep current files and dismiss</button>{/if}
            </p>
          {:else}
            <div class="history-status" class:success={entry.status === 'success'} role="status">
              {#if entry.status === 'waiting'}{entry.error} {countdown(entry.retryAt!)}
              {:else if entry.status === 'applying'}Applying…
              {:else if entry.status === 'retrying'}Retrying…
              {:else if entry.status === 'reviewing'}Reviewing…
              {:else if entry.status === 'queued'}Waiting for earlier changes…
              {:else if entry.status === 'disconnected'}Reconnect the original folder to continue.
              {:else}Success{/if}
            </div>
            {#if entry.error && entry.status !== 'waiting'}<p class="history-error">{entry.error}</p>{/if}
          {/if}
        </article>
      {/each}
    </div>
  </div>
</aside>
