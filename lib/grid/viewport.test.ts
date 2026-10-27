import { describe, expect, it } from 'vitest';
import { isInViewport, isShown, type Box } from './viewport';

const box = (top: number, left = 10, height = 200, width = 150): Box => ({
  top,
  left,
  height,
  width,
  bottom: top + height,
  right: left + width,
});

describe('isInViewport', () => {
  it('counts a box fully inside', () => {
    expect(isInViewport(box(100), 1200, 800)).toBe(true);
  });

  it('counts a box that is only partly in view, at any edge', () => {
    expect(isInViewport(box(-150), 1200, 800)).toBe(true);
    expect(isInViewport(box(700), 1200, 800)).toBe(true);
    expect(isInViewport(box(100, -100), 1200, 800)).toBe(true);
    expect(isInViewport(box(100, 1100), 1200, 800)).toBe(true);
  });

  it('does not count a box above, below, left or right of the viewport', () => {
    expect(isInViewport(box(-300), 1200, 800)).toBe(false);
    expect(isInViewport(box(-200), 1200, 800)).toBe(false);
    expect(isInViewport(box(800), 1200, 800)).toBe(false);
    expect(isInViewport(box(100, -200), 1200, 800)).toBe(false);
    expect(isInViewport(box(100, 1200), 1200, 800)).toBe(false);
  });

  it('does not count a box without a size (hidden, not laid out)', () => {
    expect(isInViewport(box(100, 10, 0), 1200, 800)).toBe(false);
    expect(isInViewport(box(100, 10, 200, 0), 1200, 800)).toBe(false);
  });
});

describe('isShown', () => {
  it('reads the box and the window of the element', () => {
    const element = document.createElement('div');
    document.body.append(element);
    // happy-dom lays nothing out: every box is empty, so nothing shows.
    expect(isShown(element)).toBe(false);
    element.getBoundingClientRect = () => ({ ...box(10), x: 0, y: 0, toJSON: () => ({}) });
    expect(isShown(element)).toBe(true);
    element.remove();
  });
});
