<script lang="ts">
  import { sourceLabel } from '../lib/source-names';
  let { files, total, available, source = $bindable(), onChange }: {
    files: string[]; total: number; available: number;
    source: string; onChange: () => void;
  } = $props();
</script>

<aside class="collection" aria-label="Collection">
  <div class="source-select">
    <label for="source">Practice from</label>
    <span class="source-choice">
      <span class="source-choice-label" aria-hidden="true">{source ? sourceLabel(source) : 'All materials'}</span>
      <span class="source-choice-arrow" aria-hidden="true">⌄</span>
      <select id="source" bind:value={source} onchange={onChange}>
        <option value="">All materials</option>
        {#each files as file}
          <option value={file}>{sourceLabel(file)}</option>
        {/each}
      </select>
    </span>
  </div>
  <span class="collection-count">{source ? `${available} / ${total}` : total} cards</span>
</aside>
