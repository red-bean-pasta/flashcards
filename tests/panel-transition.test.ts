import test from 'node:test';
import assert from 'node:assert/strict';
import { bannerSlideTransition } from '../src/lib/panel-transition.ts';

test('bannerSlideTransition computes translateY based on explicit distance', () => {
  const el = { style: { bottom: '20px' }, offsetHeight: 60 } as unknown as HTMLElement;
  const transition = bannerSlideTransition(el, { duration: 180, distance: 135 });

  assert.equal(transition.duration, 180);
  assert.equal(transition.css(1, 0), 'transform: translateY(0px);');
  assert.equal(transition.css(0, 1), 'transform: translateY(135px);');
  assert.equal(transition.css(0.5, 0.5), 'transform: translateY(67.5px);');
});

test('bannerSlideTransition falls back to element bottom style and offsetHeight when distance is omitted', () => {
  const el = { style: { bottom: '55px' }, offsetHeight: 80 } as unknown as HTMLElement;
  const transition = bannerSlideTransition(el, { duration: 200 });

  assert.equal(transition.duration, 200);
  assert.equal(transition.css(0, 1), 'transform: translateY(135px);');
});

test('bannerSlideTransition fails loudly on negative or non-finite distance', () => {
  const el = { style: { bottom: '0px' }, offsetHeight: 80 } as unknown as HTMLElement;
  assert.throws(() => bannerSlideTransition(el, { distance: -10 }), /Invalid banner slide distance/);
  assert.throws(() => bannerSlideTransition(el, { distance: NaN }), /Invalid banner slide distance/);
  assert.throws(() => bannerSlideTransition(el, { distance: Infinity }), /Invalid banner slide distance/);
});
