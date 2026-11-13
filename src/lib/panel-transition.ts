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
  const el = node as HTMLElement;
  const bottom = parseFloat(el.style.bottom) || 0;
  const height = el.offsetHeight || 75;
  const travel = distance ?? (bottom + height);

  return {
    duration: typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : duration,
    easing: cubicOut,
    css: (_t: number, u: number) => `transform: translateY(${u * travel}px);`,
  };
}
