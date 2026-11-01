import test from 'node:test';
import assert from 'node:assert/strict';
import { clampPanelWidth, panelWidthBounds } from '../src/lib/panel-width.ts';

test('panel retains its displayed width after viewport changes, subject to new limits', () => {
  const wide = { width: 1200, height: 800 };
  const narrow = { width: 400, height: 800 };
  assert.equal(clampPanelWidth(350, wide), 350);
  assert.equal(clampPanelWidth(350, narrow), 350);
  const constrained = clampPanelWidth(600, narrow);
  assert.equal(constrained, 400);
  assert.equal(clampPanelWidth(constrained, wide), 400);
});

test('slide-over limits scale with the viewport and allow a two-thirds default', () => {
  const viewport = { width: 400, height: 800 };
  assert.deepEqual(panelWidthBounds(viewport), { min: 200, max: 400 });
  assert.equal(clampPanelWidth(250, viewport), 250);
  assert.equal(clampPanelWidth(viewport.width * 2 / 3, viewport), viewport.width * 2 / 3);
  assert.equal(clampPanelWidth(-20, viewport), 200);
  assert.equal(clampPanelWidth(500, viewport), 400);
});

test('crossing the layout boundary retains widths allowed by both modes', () => {
  const overlay = { width: 665, height: 800 };
  const sideBySide = { width: 667, height: 800 };
  for (const width of [320, 400, 490]) {
    assert.equal(clampPanelWidth(clampPanelWidth(width, overlay), sideBySide), width);
    assert.equal(clampPanelWidth(clampPanelWidth(width, sideBySide), overlay), width);
  }
});

test('invalid dimensions and non-finite widths fail explicitly', () => {
  assert.throws(() => panelWidthBounds({ width: 0, height: 800 }));
  assert.throws(() => clampPanelWidth(NaN, { width: 400, height: 800 }));
});
