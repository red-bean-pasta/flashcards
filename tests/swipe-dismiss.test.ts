import assert from 'node:assert/strict';
import { test } from 'node:test';
import { swipeDismiss } from '../src/lib/swipe-dismiss.ts';

class FakeElement {
  private selector?: string;
  constructor(selector?: string) {
    this.selector = selector;
  }
  closest(selectors: string): Element | null {
    if (!this.selector) return null;
    return selectors.split(/,\s*/).includes(this.selector) ? (this as unknown as Element) : null;
  }
}

function createFakeDrawer() {
  const listeners = new Map<string, Array<(event: PointerEvent) => void>>();
  const classes = new Set<string>();
  const cssVars = new Map<string, string>();
  const captured = new Set<number>();

  const node = {
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
    style: {
      setProperty: (name: string, value: string) => cssVars.set(name, value),
      removeProperty: (name: string) => cssVars.delete(name),
      getPropertyValue: (name: string) => cssVars.get(name) ?? '',
    },
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
    getBoundingClientRect: () => ({ width: 320 }),
    addEventListener: (type: string, handler: (event: PointerEvent) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener: (type: string, handler: (event: PointerEvent) => void) => {
      const list = listeners.get(type);
      if (!list) return;
      listeners.set(type, list.filter(item => item !== handler));
    },
    dispatch(type: string, event: Partial<PointerEvent>) {
      for (const handler of listeners.get(type) ?? []) {
        handler({ type, ...event } as PointerEvent);
      }
    },
  };

  return { node: node as unknown as HTMLElement & { dispatch: typeof node.dispatch }, classes, cssVars, captured };
}

test('swipeDismiss tracks leftward touch drags and dismisses past threshold', () => {
  const previousElement = globalThis.Element;
  globalThis.Element = FakeElement as unknown as typeof Element;
  try {
    const drawer = createFakeDrawer();
    let dismissed = 0;
    const action = swipeDismiss(drawer.node, {
      canSwipe: () => true,
      onDismiss: () => { dismissed++; },
    });

    drawer.node.dispatch('pointerdown', { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 200, clientY: 100 });
    drawer.node.dispatch('pointermove', { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 185, clientY: 101 });
    assert.equal(drawer.classes.has('picker-swiping'), true);
    assert.equal(drawer.cssVars.get('--picker-swipe'), '-15px');
    assert.equal(drawer.captured.has(1), true);

    drawer.node.dispatch('pointermove', { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 110, clientY: 102 });
    assert.equal(drawer.cssVars.get('--picker-swipe'), '-90px');

    drawer.node.dispatch('pointerup', { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 110, clientY: 102 });
    assert.equal(dismissed, 1);
    assert.equal(drawer.classes.has('picker-swiping'), false);
    assert.equal(drawer.cssVars.has('--picker-swipe'), false);
    assert.equal(drawer.captured.has(1), false);

    action.destroy();
  } finally {
    globalThis.Element = previousElement;
  }
});

test('swipeDismiss snaps back cleanly on pointercancel or short swipe', () => {
  const previousElement = globalThis.Element;
  globalThis.Element = FakeElement as unknown as typeof Element;
  try {
    const drawer = createFakeDrawer();
    let dismissed = 0;
    const action = swipeDismiss(drawer.node, {
      canSwipe: () => true,
      onDismiss: () => { dismissed++; },
    });

    drawer.node.dispatch('pointerdown', { pointerType: 'touch', isPrimary: true, pointerId: 2, clientX: 200, clientY: 100 });
    drawer.node.dispatch('pointermove', { pointerType: 'touch', isPrimary: true, pointerId: 2, clientX: 160, clientY: 100 });
    assert.equal(drawer.cssVars.get('--picker-swipe'), '-40px');
    drawer.node.dispatch('pointerup', { pointerType: 'touch', isPrimary: true, pointerId: 2, clientX: 160, clientY: 100 });
    assert.equal(dismissed, 0);
    assert.equal(drawer.classes.has('picker-swiping'), false);

    drawer.node.dispatch('pointerdown', { pointerType: 'touch', isPrimary: true, pointerId: 3, clientX: 200, clientY: 100 });
    drawer.node.dispatch('pointermove', { pointerType: 'touch', isPrimary: true, pointerId: 3, clientX: 90, clientY: 100 });
    drawer.node.dispatch('pointercancel', { pointerType: 'touch', isPrimary: true, pointerId: 3, clientX: 90, clientY: 100 });
    assert.equal(dismissed, 0);
    assert.equal(drawer.classes.has('picker-swiping'), false);
    assert.equal(drawer.cssVars.has('--picker-swipe'), false);

    action.destroy();
  } finally {
    globalThis.Element = previousElement;
  }
});

test('swipeDismiss ignores vertical scrolling, rightward swipes, ignored controls, and disabled state', () => {
  const previousElement = globalThis.Element;
  globalThis.Element = FakeElement as unknown as typeof Element;
  try {
    const drawer = createFakeDrawer();
    let canSwipe = true;
    let dismissed = 0;
    const action = swipeDismiss(drawer.node, {
      canSwipe: () => canSwipe,
      onDismiss: () => { dismissed++; },
    });

    drawer.node.dispatch('pointerdown', { pointerType: 'mouse', isPrimary: true, pointerId: 4, clientX: 200, clientY: 100 });
    drawer.node.dispatch('pointermove', { pointerType: 'mouse', isPrimary: true, pointerId: 4, clientX: 80, clientY: 100 });
    assert.equal(drawer.classes.has('picker-swiping'), false);

    drawer.node.dispatch('pointerdown', { pointerType: 'touch', isPrimary: true, pointerId: 5, clientX: 200, clientY: 100, target: new FakeElement('.picker-resize') as unknown as EventTarget });
    drawer.node.dispatch('pointermove', { pointerType: 'touch', isPrimary: true, pointerId: 5, clientX: 80, clientY: 100 });
    assert.equal(drawer.classes.has('picker-swiping'), false);

    drawer.node.dispatch('pointerdown', { pointerType: 'touch', isPrimary: true, pointerId: 6, clientX: 200, clientY: 100 });
    drawer.node.dispatch('pointermove', { pointerType: 'touch', isPrimary: true, pointerId: 6, clientX: 198, clientY: 120 });
    drawer.node.dispatch('pointermove', { pointerType: 'touch', isPrimary: true, pointerId: 6, clientX: 80, clientY: 120 });
    assert.equal(drawer.classes.has('picker-swiping'), false);

    drawer.node.dispatch('pointerdown', { pointerType: 'touch', isPrimary: true, pointerId: 7, clientX: 200, clientY: 100 });
    drawer.node.dispatch('pointermove', { pointerType: 'touch', isPrimary: true, pointerId: 7, clientX: 170, clientY: 100 });
    assert.equal(drawer.classes.has('picker-swiping'), true);
    canSwipe = false;
    action.update({ canSwipe: () => canSwipe, onDismiss: () => { dismissed++; } });
    assert.equal(drawer.classes.has('picker-swiping'), false);
    assert.equal(drawer.cssVars.has('--picker-swipe'), false);

    assert.equal(dismissed, 0);
    action.destroy();
  } finally {
    globalThis.Element = previousElement;
  }
});
