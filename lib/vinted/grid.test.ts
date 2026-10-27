import { describe, expect, it } from 'vitest';
import { pickPhotoUrl, readGridCard, readGridCards } from './grid';

// Synthetic cards shaped like Vinted's grids. Every id, name and photo is made up.
const THUMB = 'https://images1.vinted.net/t/01_aa/310x430/aa.webp?s=1';
const TINY = 'https://images1.vinted.net/t/01_aa/100x100/aa.webp?s=2';
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

function page(html: string): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = html;
  return doc;
}

interface CatalogCardOptions {
  id?: string;
  href?: string | null;
  src?: string;
  title?: string;
  description?: boolean;
}

/** A catalogue / search card: `grid-item` > `product-item-id-<id>`. */
function catalogCard({
  id = '9000101',
  href = `/items/${id}-robe-test?referrer=catalog`,
  src = THUMB,
  title = 'Marque Test',
  description = true,
}: CatalogCardOptions = {}): string {
  const p = `product-item-id-${id}`;
  return `
    <div data-testid="grid-item">
      <div data-testid="${p}">
        ${href === null ? '' : `<a data-testid="${p}--overlay-link" href="${href}" title="Robe"></a>`}
        <img data-testid="${p}--image--img" src="${src}" alt="Robe">
        ${
          description
            ? `<div data-testid="${p}--description">
                 <p data-testid="${p}--description-title">${title}</p>
                 <p data-testid="${p}--description-subtitle">M  ·
                   Très bon état</p>
                 <p data-testid="${p}--price-text">12,00 €</p>
               </div>`
            : ''
        }
      </div>
    </div>`;
}

/** A home feed card: the id is only in the link. */
function feedCard(id = '9000201'): string {
  return `
    <div data-testid="feed-item">
      <a data-testid="feed-item--overlay-link" href="https://www.vinted.fr/items/${id}-pull-test"></a>
      <img data-testid="feed-item--image--img" src="${THUMB}">
      <div data-testid="feed-item--description">
        <p data-testid="feed-item--description-title">Autre Marque</p>
        <p data-testid="feed-item--description-subtitle">L · Bon état</p>
        <p data-testid="feed-item--price-text">8,50 €</p>
      </div>
    </div>`;
}

describe('readGridCards', () => {
  it('reads a catalogue card: id, item url, photo, title, subtitle, price', () => {
    const doc = page(catalogCard());
    const [card, ...rest] = readGridCards(doc);
    expect(rest).toEqual([]);
    expect(card).toMatchObject({
      id: '9000101',
      photoUrl: THUMB,
      title: 'Marque Test',
      subtitle: 'M · Très bon état',
      priceText: '12,00 €',
    });
    expect(new URL(card?.url ?? '').pathname).toBe('/items/9000101-robe-test');
    expect(new URL(card?.url ?? '').search).toBe('?referrer=catalog');
    expect(card?.element.getAttribute('data-testid')).toBe('product-item-id-9000101');
  });

  it('puts the anchor on the description block, inside the card', () => {
    const doc = page(catalogCard());
    const card = readGridCards(doc)[0];
    expect(card?.anchor.getAttribute('data-testid')).toBe('product-item-id-9000101--description');
    expect(card?.element.contains(card.anchor)).toBe(true);
  });

  it('reads a home feed card and takes its id from the link', () => {
    const doc = page(feedCard());
    const [card] = readGridCards(doc);
    expect(card).toMatchObject({
      id: '9000201',
      url: 'https://www.vinted.fr/items/9000201-pull-test',
      photoUrl: THUMB,
      title: 'Autre Marque',
      subtitle: 'L · Bon état',
      priceText: '8,50 €',
    });
  });

  it('finds the id in any item link when the card has no overlay link', () => {
    const doc = page(`
      <div data-testid="feed-item">
        <a href="/member/7000001">vendeuse_test</a>
        <a href="/items/9000202-jupe-test"><img data-testid="feed-item--image--img" src="${THUMB}"></a>
        <div data-testid="feed-item--description"></div>
      </div>`);
    expect(readGridCards(doc)[0]?.id).toBe('9000202');
  });

  it('returns every card in page order, catalogue and feed alike', () => {
    const doc = page(
      catalogCard({ id: '9000101' }) + feedCard('9000201') + catalogCard({ id: '9000102' }),
    );
    expect(readGridCards(doc).map((card) => card.id)).toEqual(['9000101', '9000201', '9000102']);
  });

  it('skips the parts of a card: only the root is a card', () => {
    const doc = page(catalogCard());
    // The overlay link, the image and the description all share the `product-item-id-` prefix.
    expect(doc.querySelectorAll('[data-testid^="product-item-id-"]').length).toBeGreaterThan(1);
    expect(readGridCards(doc)).toHaveLength(1);
  });

  it('skips a card without its description block (promotion, card still being drawn)', () => {
    const doc = page(catalogCard({ description: false }) + catalogCard({ id: '9000102' }));
    expect(readGridCards(doc).map((card) => card.id)).toEqual(['9000102']);
  });

  it('skips the seller promotion cards and the similar-items cards', () => {
    const doc = page(`
      <div data-testid="closet-promotion-7000001">
        <div data-testid="closet-item-9000301"><a data-testid="item-9000301--overlay-link" href="/items/9000301"></a></div>
      </div>
      <div data-testid="similar_items-9000302"><div data-testid="similar_items-9000302--description"></div></div>`);
    expect(readGridCards(doc)).toEqual([]);
  });

  it('skips a feed card whose item cannot be told', () => {
    const doc = page(`
      <div data-testid="feed-item">
        <a href="/member/7000001"></a>
        <div data-testid="feed-item--description"></div>
      </div>`);
    expect(readGridCards(doc)).toEqual([]);
  });

  it('builds the item url from the id when the card has no usable link', () => {
    const doc = page(catalogCard({ href: null }));
    const card = readGridCards(doc)[0];
    expect(new URL(card?.url ?? '').pathname).toBe('/items/9000101');
  });

  it('trusts the testid over a link that points to another item', () => {
    const doc = page(catalogCard({ id: '9000101', href: '/items/9000999-autre' }));
    const card = readGridCards(doc)[0];
    expect(card?.id).toBe('9000101');
    expect(new URL(card?.url ?? '').pathname).toBe('/items/9000101');
  });

  it('gives empty texts when the card lacks them', () => {
    const doc = page(`
      <div data-testid="product-item-id-9000103">
        <div data-testid="product-item-id-9000103--description"></div>
      </div>`);
    expect(readGridCards(doc)[0]).toMatchObject({
      id: '9000103',
      photoUrl: null,
      title: '',
      subtitle: '',
      priceText: '',
    });
  });

  it('has no photo for a lazy-loading placeholder or a tiny thumbnail', () => {
    expect(readGridCards(page(catalogCard({ src: PLACEHOLDER })))[0]?.photoUrl).toBeNull();
    expect(readGridCards(page(catalogCard({ src: TINY })))[0]?.photoUrl).toBeNull();
  });

  it('prefers the current picture over the src when it is larger', () => {
    const doc = page(catalogCard({ src: TINY }));
    const image = doc.querySelector('img') as HTMLImageElement;
    Object.defineProperty(image, 'currentSrc', { value: THUMB });
    expect(readGridCards(doc)[0]?.photoUrl).toBe(THUMB);
  });
});

describe('readGridCard', () => {
  it('is null for an element that is not a card root', () => {
    const doc = page(catalogCard());
    expect(readGridCard(doc.body)).toBeNull();
    expect(readGridCard(doc.querySelector('[data-testid="grid-item"]') as Element)).toBeNull();
    expect(readGridCard(doc.querySelector('[data-testid$="--description"]') as Element)).toBeNull();
  });

  it('reads the same card again from its root element, with the live photo', () => {
    const doc = page(catalogCard({ src: PLACEHOLDER }));
    const root = doc.querySelector('[data-testid="product-item-id-9000101"]') as Element;
    expect(readGridCard(root)?.photoUrl).toBeNull();
    (root.querySelector('img') as HTMLImageElement).src = THUMB;
    expect(readGridCard(root)?.photoUrl).toBe(THUMB);
  });
});

describe('pickPhotoUrl', () => {
  it('keeps an https picture of the Vinted image CDN', () => {
    expect(pickPhotoUrl([THUMB])).toBe(THUMB);
    expect(pickPhotoUrl(['https://images2.vinted.net/tc/01/aa.jpeg?s=3'])).toContain('/tc/01/');
  });

  it('takes the first usable candidate', () => {
    expect(pickPhotoUrl(['', undefined, null, TINY, THUMB])).toBe(THUMB);
  });

  it('refuses other hosts, other schemes and look-alike hosts', () => {
    expect(pickPhotoUrl(['https://example.com/310x430/a.webp'])).toBeNull();
    expect(pickPhotoUrl(['http://images1.vinted.net/t/01/310x430/a.webp'])).toBeNull();
    expect(pickPhotoUrl(['https://images1.vinted.net.evil.test/t/01/310x430/a.webp'])).toBeNull();
    expect(pickPhotoUrl(['https://evilvinted.net/t/01/310x430/a.webp'])).toBeNull();
    expect(pickPhotoUrl([PLACEHOLDER, 'not a url', '/relative/310x430/a.webp'])).toBeNull();
  });

  it('skips thumbnails of 100 px or less on their longest side', () => {
    expect(pickPhotoUrl(['https://images1.vinted.net/t/01/100x100/a.webp'])).toBeNull();
    expect(pickPhotoUrl(['https://images1.vinted.net/t/01/70x100/a.webp'])).toBeNull();
    expect(pickPhotoUrl(['https://images1.vinted.net/t/01/150x210/a.webp'])).not.toBeNull();
  });
});
