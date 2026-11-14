<script lang="ts">
  let { remaining, total }: { remaining: number; total: number } = $props();
  const validRemaining = $derived.by(() => {
    if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(remaining) || remaining < 0 || remaining > total) {
      throw new Error('Progress requires a positive total and a remaining count between zero and total.');
    }
    return remaining;
  });
</script>

<progress
  class="remaining-line"
  aria-label="Questions remaining in this round"
  value={validRemaining}
  max={total}
></progress>

<style>
  .remaining-line {
    appearance: none;
    -webkit-appearance: none;
    display: block;
    inline-size: 100%;
    block-size: 100%;
    min-inline-size: 0;
    min-block-size: 0;
    border: 0 solid;
    background: transparent;
    color: #a7b29a;
    pointer-events: none;
  }

  .remaining-line::-webkit-progress-bar {
    background: transparent;
  }

  .remaining-line::-webkit-progress-value {
    background: #a7b29a;
    transition: inline-size 400ms ease;
  }

  .remaining-line::-moz-progress-bar {
    background: #a7b29a;
    transition: inline-size 400ms ease;
  }

  @media (prefers-reduced-motion: reduce) {
    .remaining-line::-webkit-progress-value {
      transition: none;
    }

    .remaining-line::-moz-progress-bar {
      transition: none;
    }
  }
</style>
