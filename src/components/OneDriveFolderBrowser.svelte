<script lang="ts">
  import { onMount } from 'svelte';
  import type { GraphClient, GraphItem } from '../lib/onedrive/graph';

  let { graph, disabled, run, onSelect, onClose }: {
    graph: GraphClient; disabled: boolean;
    run: (operation: () => Promise<void>) => Promise<void>;
    onSelect: (folder: GraphItem) => Promise<void>; onClose: () => void;
  } = $props();
  let trail = $state<GraphItem[]>([]);
  let folders = $state<GraphItem[]>([]);

  async function navigate(next: GraphItem[]) {
    const parent = next.at(-1);
    if (!parent) throw new Error('Cannot navigate above the OneDrive root.');
    const children = await graph.children(parent.id);
    folders = children.filter(item => !!item.folder && !item.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
    trail = next;
  }

  onMount(() => { void run(async () => navigate([await graph.root()])); });
</script>

<section class="folder-browser" aria-label="Select OneDrive folder">
  <p>{trail.map(item => item.name).join(' / ')}</p>
  <div class="storage-actions">
    <button class="text-action" disabled={disabled || trail.length < 2} onclick={() => run(() => navigate(trail.slice(0, -1)))}>Up</button>
    <button class="text-action" disabled={disabled || !trail.length} onclick={() => run(() => onSelect(trail[trail.length - 1]))}>Use this folder</button>
    <button class="text-action" disabled={disabled} onclick={onClose}>Cancel</button>
  </div>
  <ul>{#each folders as item (item.id)}<li><button class="text-action" {disabled} onclick={() => run(() => navigate([...trail, item]))}>{item.name}</button></li>{/each}</ul>
  {#if !folders.length}<p>No subfolders.</p>{/if}
</section>

<style>
  .folder-browser { background: var(--dialog-color, #f9f7f0); border: 1px solid #aaa5; border-radius: .5rem; padding: .8rem; max-width: 42rem; margin-top: .5rem; }
  .storage-actions { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
  ul { margin: .5rem 0; padding-left: 1.1rem; }
</style>
