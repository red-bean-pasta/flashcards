<script lang="ts">
  import { tick } from 'svelte';
  import { sourceLabel } from '../lib/source-names';

  let { files, text = $bindable(), chosen = $bindable(), disabled }: {
    files: string[]; text: string; chosen: string; disabled: boolean;
  } = $props();
  let root: HTMLDivElement;
  let input: HTMLInputElement;
  let expanded = $state(false);
  const suggestions = $derived([...new Set(['default.md', ...files])].filter(source =>
    source === 'default.md' || sourceLabel(source).toLowerCase().includes(text.toLowerCase())));

  function choose(source: string): void {
    chosen = source;
    text = sourceLabel(source);
    expanded = false;
    input.focus();
  }

  function leavePicker(event: FocusEvent): void {
    if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) expanded = false;
  }

  async function navigate(event: KeyboardEvent): Promise<void> {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      expanded = false;
      input.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    expanded = true;
    await tick();
    const options = [...root.querySelectorAll<HTMLButtonElement>('.file-option')];
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowUp') {
      if (current <= 0) input.focus();
      else options[current - 1].focus();
    } else if (current + 1 < options.length) options[current + 1].focus();
  }
</script>

<label for="card-file">File</label>
<div class="file-picker" bind:this={root} onfocusout={leavePicker} role="group" aria-label="Choose a file">
  <input id="card-file" bind:this={input} bind:value={text} {disabled} autocomplete="off"
    onkeydown={navigate} role="combobox" aria-autocomplete="list" aria-controls="file-suggestions" aria-expanded={expanded}
    oninput={() => { chosen = ''; expanded = true; }} />
  {#if expanded}
    <div id="file-suggestions" class="file-suggestions" role="listbox" aria-label="File suggestions">
      {#each suggestions as source}
        <button type="button" class="file-option" role="option" aria-selected={chosen === source}
          onkeydown={navigate} onclick={() => choose(source)} {disabled}>{sourceLabel(source)}<small>{source}</small></button>
      {/each}
    </div>
  {/if}
</div>
