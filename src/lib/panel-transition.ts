import { cubicOut } from 'svelte/easing';

export function panelTransition(_node: Element, { axis, duration }: { axis: 'X' | 'Y'; duration: number }) {
  return {
    duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration,
    easing: cubicOut,
    css: (progress: number) => `transform: translate${axis}(${(1 - progress) * 100}%);`,
  };
}
