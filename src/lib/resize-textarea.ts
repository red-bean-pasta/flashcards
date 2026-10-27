// Keep the native textarea, replacing its corner grip with a full-width bottom edge.
export function resizeTextarea(node: HTMLTextAreaElement) {
  const edgeSize = 7;
  let drag: { pointer: number; y: number; height: number } | undefined;

  function atBottom(event: PointerEvent): boolean {
    const bounds = node.getBoundingClientRect();
    return event.clientY >= bounds.bottom - edgeSize && event.clientY <= bounds.bottom;
  }

  function beginResize(event: PointerEvent): void {
    if (node.disabled || event.button !== 0 || event.pointerType !== 'mouse' || !atBottom(event)) return;
    event.preventDefault();
    drag = { pointer: event.pointerId, y: event.clientY, height: node.getBoundingClientRect().height };
    node.setPointerCapture(event.pointerId);
  }

  function movePointer(event: PointerEvent): void {
    if (drag) {
      const minimum = Number.parseFloat(getComputedStyle(node).minHeight);
      if (!Number.isFinite(minimum)) throw new Error('Resizable textarea requires a numeric CSS min-height.');
      node.style.height = `${Math.max(minimum, drag.height + event.clientY - drag.y)}px`;
    }
    node.style.cursor = !node.disabled && (drag || atBottom(event)) ? 'ns-resize' : 'text';
  }

  function endResize(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    drag = undefined;
    node.style.cursor = !node.disabled && atBottom(event) ? 'ns-resize' : 'text';
  }

  node.addEventListener('pointerdown', beginResize);
  node.addEventListener('pointermove', movePointer);
  node.addEventListener('pointerup', endResize);
  node.addEventListener('pointercancel', endResize);
  node.addEventListener('lostpointercapture', endResize);
  return {
    destroy() {
      node.removeEventListener('pointerdown', beginResize);
      node.removeEventListener('pointermove', movePointer);
      node.removeEventListener('pointerup', endResize);
      node.removeEventListener('pointercancel', endResize);
      node.removeEventListener('lostpointercapture', endResize);
    },
  };
}
