<script lang="ts">
  let { files, total, available, source = $bindable(), onChange }: {
    files: string[]; total: number; available: number;
    source: string; onChange: () => void;
  } = $props();
</script>

<aside class="collection" aria-label="Collection">
  <div class="source-select">
    <label for="source">Practice from</label>
    <select id="source" bind:value={source} onchange={onChange}>
      <option value="">All materials</option>
      {#each files as file}
        <option value={file}>{file.replace(/\.md$/i, '').replaceAll('-', ' ')}</option>
      {/each}
    </select>
  </div>
  <span class="collection-count">{source ? `${available} / ${total}` : total} cards</span>
</aside>
