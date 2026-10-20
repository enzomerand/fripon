import { SELECTORS } from './selectors';

export interface Anchor {
  element: Element;
  /** Where the card goes relative to `element`. */
  position: 'after' | 'before';
}

/**
 * Where to insert the card: right after the price block, else just before the buy / offer
 * buttons. Null while neither is in the page.
 */
export function findAnchor(doc: Document): Anchor | null {
  const price =
    doc.querySelector(SELECTORS.priceBlock) ?? doc.querySelector(SELECTORS.priceContainer);
  if (price) return { element: price, position: 'after' };

  const actions = doc.querySelector(SELECTORS.actionsBlock);
  return actions ? { element: actions, position: 'before' } : null;
}
