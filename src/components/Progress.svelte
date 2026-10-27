<script lang="ts">
  let { remaining, total }: { remaining: number; total: number } = $props();
  const fraction = $derived.by(() => {
    if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(remaining) || remaining < 0 || remaining > total) {
      throw new Error('Progress requires a positive total and a remaining count between zero and total.');
    }
    return remaining / total;
  });
</script>

<div class="remaining-line" role="progressbar" aria-label="Questions remaining in this round"
  aria-valuenow={remaining} aria-valuemin={0} aria-valuemax={total}>
  <div class="progress-fill" style:--remaining-fraction={fraction}></div>
</div>

<style>
  .remaining-line {
    position: relative;
    min-width: 0;
    min-height: 0;
    pointer-events: none;
  }
  .progress-fill {
    position: absolute;
    inset: 0;
    background: #a7b29a;
    transform: scaleX(var(--remaining-fraction));
    transform-origin: top left;
    transition: transform 400ms ease;
  }
</style>
