export interface Viewport { width: number; height: number }

export function panelWidthBounds(viewport: Viewport) {
  if (!(viewport.width > 0 && viewport.height > 0)) throw new Error('Panel viewport dimensions must be positive.');
  const overlay = viewport.width / viewport.height < 5 / 6;
  return {
    min: Math.min(viewport.height * .4, viewport.width * .5),
    max: viewport.width * (overlay ? 1 : .75),
  };
}

export function clampPanelWidth(width: number, viewport: Viewport) {
  if (!Number.isFinite(width)) throw new Error('Panel width must be finite.');
  const { min, max } = panelWidthBounds(viewport);
  return Math.min(max, Math.max(min, width));
}
