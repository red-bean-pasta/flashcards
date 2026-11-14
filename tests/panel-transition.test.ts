import test from 'node:test';
import assert from 'node:assert/strict';
import { bannerSlideTransition } from '../src/lib/panel-transition.ts';

test('bannerSlideTransition computes translateY based on explicit distance without layout reads', () => {
  const el = {
    get style(): CSSStyleDeclaration {
      throw new Error('Explicit distance should not inspect inline styles.');
    },
    get offsetHeight(): number {
      throw new Error('Explicit distance should not force layout reads.');
    },
  } as unknown as HTMLElement;
  const transition = bannerSlideTransition(el, { duration: 180, distance: 135 });

  assert.equal(transition.duration, 180);
  assert.equal(transition.css(1, 0), 'transform: translateY(0px);');
  assert.equal(transition.css(0, 1), 'transform: translateY(135px);');
  assert.equal(transition.css(0.5, 0.5), 'transform: translateY(67.5px);');
});

test('bannerSlideTransition reads --banner-offset or bottom style and offsetHeight when distance is omitted', () => {
  const cssVarEl = {
    style: { getPropertyValue: (name: string) => (name === '--banner-offset' ? '55px' : '') },
    offsetHeight: 80,
  } as unknown as HTMLElement;
  const cssVarTransition = bannerSlideTransition(cssVarEl, { duration: 200 });
  assert.equal(cssVarTransition.duration, 200);
  assert.equal(cssVarTransition.css(0, 1), 'transform: translateY(135px);');

  const bottomEl = { style: { bottom: '55px' }, offsetHeight: 80 } as unknown as HTMLElement;
  const bottomTransition = bannerSlideTransition(bottomEl, { duration: 200 });
  assert.equal(bottomTransition.css(0, 1), 'transform: translateY(135px);');
});

test('bannerSlideTransition fails loudly on negative or non-finite distance', () => {
  const el = { style: { bottom: '0px' }, offsetHeight: 80 } as unknown as HTMLElement;
  assert.throws(() => bannerSlideTransition(el, { distance: -10 }), /Invalid banner slide distance/);
  assert.throws(() => bannerSlideTransition(el, { distance: NaN }), /Invalid banner slide distance/);
  assert.throws(() => bannerSlideTransition(el, { distance: Infinity }), /Invalid banner slide distance/);
});
