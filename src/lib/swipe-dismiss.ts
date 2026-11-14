export interface SwipeDismissOptions {
  canSwipe: () => boolean;
  onDismiss: () => void;
  ignoreSelector?: string;
}

/** Tracks leftward touch swipes on a slide-over drawer to dismiss it interactively. */
export function swipeDismiss(node: HTMLElement, initialOptions: SwipeDismissOptions) {
  let options = initialOptions;
  let drag: { pointer: number; startX: number; startY: number; offset: number; locked: boolean } | undefined;

  function clearSwipeState(): void {
    drag = undefined;
    node.classList.remove('picker-swiping');
    node.style.removeProperty('--picker-swipe');
  }

  function beginSwipe(event: PointerEvent): void {
    if (event.pointerType !== 'touch' || !event.isPrimary || !options.canSwipe()) return;
    const ignore = options.ignoreSelector ?? '.picker-resize, button';
    if (event.target instanceof Element && event.target.closest(ignore)) return;
    drag = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, offset: 0, locked: false };
  }

  function moveSwipe(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.locked) {
      if (Math.hypot(dx, dy) < 10) return;
      if (Math.abs(dy) >= Math.abs(dx) || dx >= 0) {
        clearSwipeState();
        return;
      }
      drag.locked = true;
      node.classList.add('picker-swiping');
      node.setPointerCapture?.(event.pointerId);
    }
    drag.offset = Math.min(0, dx);
    node.style.setProperty('--picker-swipe', `${drag.offset}px`);
  }

  function endSwipe(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (node.hasPointerCapture?.(event.pointerId)) node.releasePointerCapture(event.pointerId);
    const threshold = Math.min(80, node.getBoundingClientRect().width * 0.25);
    const shouldDismiss = event.type === 'pointerup' && drag.locked && -drag.offset >= threshold;
    clearSwipeState();
    if (shouldDismiss) options.onDismiss();
  }

  node.addEventListener('pointerdown', beginSwipe);
  node.addEventListener('pointermove', moveSwipe);
  node.addEventListener('pointerup', endSwipe);
  node.addEventListener('pointercancel', endSwipe);
  node.addEventListener('lostpointercapture', endSwipe);

  return {
    update(nextOptions: SwipeDismissOptions) {
      options = nextOptions;
      if (drag && !options.canSwipe()) clearSwipeState();
    },
    destroy() {
      clearSwipeState();
      node.removeEventListener('pointerdown', beginSwipe);
      node.removeEventListener('pointermove', moveSwipe);
      node.removeEventListener('pointerup', endSwipe);
      node.removeEventListener('pointercancel', endSwipe);
      node.removeEventListener('lostpointercapture', endSwipe);
    },
  };
}
