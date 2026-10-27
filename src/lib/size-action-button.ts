// CSS consumes the measured label dimensions so its ratios remain user configurable.
export function sizeActionButton(node: HTMLButtonElement) {
  const label = node.firstElementChild;
  if (!(label instanceof HTMLSpanElement)) throw new Error('Action buttons require a span containing their label.');

  const measureLabel = (): void => {
    const bounds = label.getBoundingClientRect();
    node.style.setProperty('--action-label-width', `${bounds.width}px`);
    node.style.setProperty('--action-label-height', `${bounds.height}px`);
  };

  measureLabel();
  const observer = new ResizeObserver(measureLabel);
  observer.observe(label);
  return { destroy() { observer.disconnect(); } };
}
