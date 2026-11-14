import { cubicOut } from 'svelte/easing';

export function panelTransition(_node: Element, { axis, duration }: { axis: 'X' | 'Y'; duration: number }) {
  return {
    duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration,
    easing: cubicOut,
    css: (progress: number) => `transform: translate${axis}(${(1 - progress) * 100}%);`,
  };
}

export function bannerSlideTransition(
  node: Element,
  { duration = 180, distance }: { duration?: number; distance?: number } = {}
) {
  if (distance !== undefined && (!Number.isFinite(distance) || distance < 0)) {
    throw new Error(`Invalid banner slide distance: ${distance}`);
  }
  let travel = distance;
  if (travel === undefined) {
    const el = node as HTMLElement;
    const inlineVar = el.style?.getPropertyValue?.('--banner-offset') ?? '';
    const computedVar = inlineVar || typeof getComputedStyle !== 'function'
      ? ''
      : getComputedStyle(el).getPropertyValue('--banner-offset');
    const offset = parseFloat(inlineVar || computedVar) || parseFloat(el.style?.bottom ?? '') || 0;
    const height = el.offsetHeight || 75;
    travel = offset + height;
  }

  return {
    duration: typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : duration,
    easing: cubicOut,
    css: (_t: number, u: number) => `transform: translateY(${u * travel}px);`,
  };
}
