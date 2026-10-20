import { describe, expect, it } from 'vitest';
import { findAnchor } from './anchor';

function page(html: string): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = html;
  return doc;
}

describe('findAnchor', () => {
  it('prefers the spot right after the price block', () => {
    const doc = page(`
      <div class="details-list--pricing"><div data-testid="item-sidebar-price-container"></div></div>
      <div class="details-list--actions"></div>`);
    const anchor = findAnchor(doc);
    expect(anchor?.position).toBe('after');
    expect(anchor?.element.className).toBe('details-list--pricing');
  });

  it('uses the price container when the pricing block is missing', () => {
    const doc = page('<div data-testid="item-sidebar-price-container" id="c"></div>');
    expect(findAnchor(doc)).toMatchObject({ position: 'after' });
    expect(findAnchor(doc)?.element.id).toBe('c');
  });

  it('falls back on the position before the action buttons', () => {
    const doc = page('<div class="details-list--actions" id="a"></div>');
    const anchor = findAnchor(doc);
    expect(anchor?.position).toBe('before');
    expect(anchor?.element.id).toBe('a');
  });

  it('is null when no anchor is there', () => {
    expect(findAnchor(page('<p>nothing</p>'))).toBeNull();
  });
});
