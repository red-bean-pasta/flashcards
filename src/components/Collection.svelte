<script lang="ts">
  import { sourceLabel } from '../lib/source-names';
  import { buildMaterialTree, findAncestorFolders, type MaterialFolder } from '../lib/material-tree';
  import { formatPathSpec } from '../lib/path-spec';
  import { bannerSlideTransition } from '../lib/panel-transition';

  let { files, total, available, source = $bindable(), disabled = false, rootName = '', onChange }: {
    files: string[]; total: number; available: number;
    source: string; disabled?: boolean; rootName?: string; onChange: () => void;
  } = $props();

  const tree = $derived(buildMaterialTree(files));
  let isOpen = $state(false);
  let openFolders = $state<MaterialFolder[]>([]);
  let heights = $state<number[]>([]);
  let labelEl = $state<HTMLElement>();
  let bannerBottomPadding = $state(25);

  function updateAlignment() {
    if (!labelEl) return;
    const labelRect = labelEl.getBoundingClientRect();
    const practiceCenterY = labelRect.top + labelRect.height / 2;
    const centerFromBottom = window.innerHeight - practiceCenterY;
    const itemHeight = labelRect.height;
    bannerBottomPadding = Math.max(12, Math.round(centerFromBottom - itemHeight / 2));
  }

  function toggleOpen() {
    if (disabled) return;
    isOpen = !isOpen;
    if (isOpen) {
      updateAlignment();
      openFolders = findAncestorFolders(tree, source);
    }
  }

  function chooseSource(target: string) {
    const isUnchanged = source === target;
    isOpen = false;
    if (!isUnchanged) {
      source = target;
      onChange();
    }
  }

  function measureBanner(node: HTMLElement, depth: number) {
    heights[depth] = node.offsetHeight;
    const observer = new ResizeObserver(() => { heights[depth] = node.offsetHeight; });
    observer.observe(node);
    return {
      update(d: number) { depth = d; heights[depth] = node.offsetHeight; },
      destroy() { observer.disconnect(); }
    };
  }

  const eatenMargin = $derived(Math.round(bannerBottomPadding / 2));

  function getBannerHeight(depth: number): number {
    return heights[depth] || (labelEl ? labelEl.offsetHeight + 2 * bannerBottomPadding : 80);
  }

  function getBottomOffset(depth: number, totalBanners: number): number {
    let offset = 0;
    for (let j = depth + 1; j < totalBanners; j++) {
      offset += Math.max(0, getBannerHeight(j) - eatenMargin);
    }
    return offset;
  }

  const totalStackDistance = $derived(
    openFolders.length ? getBottomOffset(0, openFolders.length) + getBannerHeight(0) : 0
  );

  const savedOffsets: number[] = [];

  function getBannerOffset(depth: number): number {
    if (depth < openFolders.length) {
      const offset = getBottomOffset(depth, openFolders.length);
      savedOffsets[depth] = offset;
      return offset;
    }
    return savedOffsets[depth] ?? 0;
  }

  function getBannerSlideDistance(depth: number): number {
    if (!isOpen) return totalStackDistance;
    if (depth >= openFolders.length) {
      const exitDepth = openFolders.length;
      const baseOffset = savedOffsets[exitDepth] ?? 0;
      return baseOffset + getBannerHeight(exitDepth);
    }
    return getBottomOffset(depth, openFolders.length) + getBannerHeight(depth);
  }

  function handleBannerPointerDown(e: PointerEvent, depth: number) {
    if ((e.target as HTMLElement | null)?.closest('button')) return;
    if (depth < openFolders.length - 1) openFolders = openFolders.slice(0, depth + 1);
  }

  function onWindowPointerDown(e: PointerEvent) {
    if (!isOpen) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('.material-banner') || target?.closest('#source-trigger')) return;
    isOpen = false;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape' && isOpen) {
      isOpen = false;
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onKeyDown} onresize={updateAlignment} />

{#if !disabled}
  <div class="collection">
    <div class="source-select">
      <span id="source-label" class="source-select-label" bind:this={labelEl}>Practice from</span>
      <div class="source-choice-anchor">
        <button id="source-trigger" type="button" class="source-choice-button" aria-haspopup="dialog"
          aria-labelledby="source-label source-trigger" aria-expanded={isOpen} onclick={toggleOpen}>
          <span class="source-choice-label">{source ? sourceLabel(source) : 'All materials'}</span>
          <span class="source-choice-arrow" aria-hidden="true">⌄</span>
        </button>
      </div>
    </div>
    <span class="collection-count">{source ? `${available} / ${total}` : total} cards</span>
  </div>
{/if}

{#if isOpen}
  <div class="material-banner-stack">
    {#each openFolders as folder, depth (depth)}
      <aside class="material-banner" aria-label="Materials in {folder.name}"
        style="--banner-offset: {getBannerOffset(depth)}px; padding-block: {bannerBottomPadding}px; z-index: {40 + depth};"
        use:measureBanner={depth} onpointerdown={e => handleBannerPointerDown(e, depth)}
        transition:bannerSlideTransition|global={{
          duration: 180,
          distance: getBannerSlideDistance(depth)
        }}>
        <span class="material-banner-path" aria-hidden="true">{formatPathSpec(folder.path, rootName)}</span>
        <div class="material-banner-scroll">
          <div class="material-banner-items">
            <button type="button" class="material-banner-item is-all-materials" class:is-selected={source === folder.path}
              onclick={() => chooseSource(folder.path)}>All materials</button>
            {#each folder.folders as sub (sub.path)}
              <button type="button" class="material-banner-item is-folder"
                onclick={() => { openFolders = [...openFolders.slice(0, depth + 1), sub]; }}>{sub.name}</button>
            {/each}
            {#each folder.files as file (file.path)}
              <button type="button" class="material-banner-item" class:is-selected={source === file.path}
                onclick={() => chooseSource(file.path)}>{file.name}</button>
            {/each}
          </div>
        </div>
      </aside>
    {/each}
  </div>
{/if}
