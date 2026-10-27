/** What `getBoundingClientRect` gives, and all that is needed of it. */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/**
 * Whether a box shows in a viewport of `width` x `height`: any part of it counts, but a box with no
 * size (hidden, not laid out) does not.
 */
export function isInViewport(box: Box, width: number, height: number): boolean {
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.bottom > 0 &&
    box.top < height &&
    box.right > 0 &&
    box.left < width
  );
}

/** Whether `element` shows in the window of its document right now. */
export function isShown(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  return isInViewport(
    element.getBoundingClientRect(),
    view?.innerWidth ?? 0,
    view?.innerHeight ?? 0,
  );
}
