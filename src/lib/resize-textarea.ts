// Keep the native textarea, replacing its corner grip with a full-width bottom edge.
export function resizeTextarea(node: HTMLTextAreaElement) {
  let drag: { pointer: number; y: number; height: number } | undefined;

  function edgeSize(pointerType: string): number {
    return pointerType === 'mouse' ? 7 : 14;
  }

  function atBottom(clientY: number, band: number): boolean {
    const bounds = node.getBoundingClientRect();
    return clientY >= bounds.bottom - band && clientY <= bounds.bottom;
  }

  function preventBottomScroll(event: TouchEvent): void {
    if (node.disabled || event.touches.length !== 1) return;
    if (atBottom(event.touches[0].clientY, edgeSize('touch'))) {
      event.preventDefault();
    }
  }

  function beginResize(event: PointerEvent): void {
    if (node.disabled || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!atBottom(event.clientY, edgeSize(event.pointerType))) return;
    event.preventDefault();
    drag = { pointer: event.pointerId, y: event.clientY, height: node.getBoundingClientRect().height };
    node.setPointerCapture(event.pointerId);
  }

  function movePointer(event: PointerEvent): void {
    if (drag && event.pointerId === drag.pointer) {
      const minimum = Number.parseFloat(getComputedStyle(node).minBlockSize);
      if (!Number.isFinite(minimum)) throw new Error('Resizable textarea requires a numeric CSS min-block-size.');
      node.style.blockSize = `${Math.max(minimum, drag.height + event.clientY - drag.y)}px`;
    }
    if (event.pointerType === 'mouse') {
      node.style.cursor = !node.disabled && (drag || atBottom(event.clientY, edgeSize(event.pointerType))) ? 'ns-resize' : 'text';
    }
  }

  function endResize(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    drag = undefined;
    if (event.pointerType === 'mouse') {
      node.style.cursor = !node.disabled && atBottom(event.clientY, edgeSize(event.pointerType)) ? 'ns-resize' : 'text';
    }
  }

  node.addEventListener('touchstart', preventBottomScroll, { passive: false });
  node.addEventListener('pointerdown', beginResize);
  node.addEventListener('pointermove', movePointer);
  node.addEventListener('pointerup', endResize);
  node.addEventListener('pointercancel', endResize);
  node.addEventListener('lostpointercapture', endResize);
  return {
    destroy() {
      node.removeEventListener('touchstart', preventBottomScroll);
      node.removeEventListener('pointerdown', beginResize);
      node.removeEventListener('pointermove', movePointer);
      node.removeEventListener('pointerup', endResize);
      node.removeEventListener('pointercancel', endResize);
      node.removeEventListener('lostpointercapture', endResize);
    },
  };
}
