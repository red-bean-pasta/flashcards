<script lang="ts">
  import { sourceLabel } from '../lib/source-names';
  import { buildMaterialTree, type MaterialFolder } from '../lib/material-tree';

  let { files, total, available, source = $bindable(), onChange }: {
    files: string[]; total: number; available: number;
    source: string; onChange: () => void;
  } = $props();

  const tree = $derived(buildMaterialTree(files));
  let isOpen = $state(false);
  let openLevels = $state<Array<{ folder: MaterialFolder; rect: DOMRect }>>([]);
  let container = $state<HTMLElement | null>(null);

  function hoverFolder(subfolder: MaterialFolder, el: HTMLElement, depth: number) {
    if (openLevels[depth]?.folder.path === subfolder.path) return;
    openLevels = [...openLevels.slice(0, depth), { folder: subfolder, rect: el.getBoundingClientRect() }];
  }

  function chooseSource(target: string) {
    source = target;
    isOpen = false;
    openLevels = [];
    onChange();
  }

  function onPointerDown(e: PointerEvent) {
    if (!isOpen) return;
    const t = e.target as Element;
    if (!container?.contains(t) && !t.closest?.('.secondary-pane')) {
      isOpen = false;
      openLevels = [];
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && isOpen) {
      if (openLevels.length) openLevels = openLevels.slice(0, -1);
      else isOpen = false;
    }
  }

  function positionPane(node: HTMLElement, anchor: DOMRect) {
    const r = node.getBoundingClientRect();
    const left = anchor.right + 2 + r.width > window.innerWidth ? anchor.left - r.width - 2 : anchor.right + 2;
    const top = Math.max(8, Math.min(anchor.top, window.innerHeight - r.height - 8));
    node.style.cssText = `position:fixed;left:${Math.max(8, left)}px;top:${top}px;`;
  }
</script>

<svelte:window onpointerdown={onPointerDown} onkeydown={onKeyDown} />

<aside class="collection" aria-label="Collection">
  <div class="source-select" bind:this={container}>
    <label for="source-trigger">Practice from</label>
    <div class="source-choice-anchor">
      <button id="source-trigger" type="button" class="source-choice-button" aria-haspopup="menu" aria-expanded={isOpen}
        onclick={() => { isOpen = !isOpen; if (isOpen) openLevels = []; }}>
        <span class="source-choice-label">{source ? sourceLabel(source) : 'All materials'}</span>
        <span class="source-choice-arrow" aria-hidden="true">⌄</span>
      </button>

      {#if isOpen}
        <div class="material-menu-pane root-pane" role="menu" tabindex="-1">
          {@render paneItems(tree, 0)}
        </div>
      {/if}
    </div>
  </div>
  <span class="collection-count">{source ? `${available} / ${total}` : total} cards</span>
</aside>

{#if isOpen}
  {#each openLevels as level, index (level.folder.path)}
    <div class="material-menu-pane secondary-pane" role="menu" tabindex="-1" use:positionPane={level.rect}>
      {@render paneItems(level.folder, index + 1)}
    </div>
  {/each}
{/if}

{#snippet paneItems(folder: MaterialFolder, depth: number)}
  <div class="menu-items-scroll">
    <button type="button" role="menuitem" class="material-menu-button" class:is-active={source === folder.path}
      onpointerenter={() => { openLevels = openLevels.slice(0, depth); }} onclick={() => chooseSource(folder.path)}>
      <span class="material-item-label">All materials</span>
      {#if source === folder.path}<span class="material-item-check" aria-hidden="true">✓</span>{/if}
    </button>
    {#each folder.folders as sub (sub.path)}
      <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={openLevels[depth]?.folder.path === sub.path}
        class="material-menu-button folder-button" class:is-open={openLevels[depth]?.folder.path === sub.path}
        onpointerenter={e => hoverFolder(sub, e.currentTarget, depth)}
        onclick={e => hoverFolder(sub, e.currentTarget, depth)}>
        <span class="material-item-label">{sub.name}</span>
        <span class="material-submenu-arrow" aria-hidden="true">›</span>
      </button>
    {/each}
    {#each folder.files as file (file.path)}
      <button type="button" role="menuitem" class="material-menu-button" class:is-active={source === file.path}
        onpointerenter={() => { openLevels = openLevels.slice(0, depth); }} onclick={() => chooseSource(file.path)}>
        <span class="material-item-label">{file.name}</span>
        {#if source === file.path}<span class="material-item-check" aria-hidden="true">✓</span>{/if}
      </button>
    {/each}
  </div>
{/snippet}
