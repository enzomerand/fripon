import { describe, expect, it } from 'vitest';
import {
  cardIdOf,
  findButtonAnchor,
  findCardRoots,
  findResultsAnchor,
  pickPhotoUrl,
  readGridCard,
  type GridCard,
} from './grid';

// Synthetic cards shaped like Vinted's grids. Every id, name and photo is made up.
const THUMB = 'https://images1.vinted.net/t/01_aa/310x430/aa.webp?s=1';
const TINY = 'https://images1.vinted.net/t/01_aa/100x100/aa.webp?s=2';
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/** Every whole card of the page, in page order. */
function readGridCards(root: ParentNode): GridCard[] {
  return findCardRoots(root).flatMap((element) => readGridCard(element) ?? []);
}

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
            ? `<div data-testid="${p}--summary">
                 <div data-testid="${p}--description">
                   <p data-testid="${p}--description-title">${title}</p>
                   <p data-testid="${p}--description-subtitle">M  ·
                     Très bon état</p>
                 </div>
                 <div data-testid="${p}--title-container">
                   <p data-testid="${p}--price-text">12,00 €</p>
                 </div>
                 <div data-testid="${p}--breakdown">
                   <span data-testid="total-combined-price">13,30 €</span>
                 </div>
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
      <div data-testid="feed-item--summary">
        <div data-testid="feed-item--description">
          <p data-testid="feed-item--description-title">Autre Marque</p>
          <p data-testid="feed-item--description-subtitle">L · Bon état</p>
        </div>
        <p data-testid="feed-item--price-text">8,50 €</p>
        <div data-testid="feed-item--breakdown"><span>9,10 €</span></div>
      </div>
    </div>`;
}

describe('reading the cards of a page', () => {
  it('reads a catalogue card: id, item url, photo, title', () => {
    const doc = page(catalogCard());
    const [card, ...rest] = readGridCards(doc);
    expect(rest).toEqual([]);
    expect(card).toMatchObject({
      id: '9000101',
      photoUrl: THUMB,
      title: 'Marque Test',
    });
    expect(new URL(card?.url ?? '').pathname).toBe('/items/9000101-robe-test');
    expect(new URL(card?.url ?? '').search).toBe('?referrer=catalog');
    expect(card?.element.getAttribute('data-testid')).toBe('product-item-id-9000101');
  });

  it('puts the anchor after the fees line, inside the card', () => {
    const doc = page(catalogCard());
    const card = readGridCards(doc)[0];
    expect(card?.anchor.getAttribute('data-testid')).toBe('product-item-id-9000101--breakdown');
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

describe('findButtonAnchor', () => {
  const rootOf = (html: string) => page(html).body.firstElementChild as Element;
  const testidOf = (element: Element | null) => element?.getAttribute('data-testid');

  it('is the fees block, below the title, the size and the price', () => {
    const root = rootOf(catalogCard().replace('grid-item', 'g'));
    const product = root.querySelector('[data-testid="product-item-id-9000101"]') as Element;
    const anchor = findButtonAnchor(product);
    expect(testidOf(anchor)).toBe('product-item-id-9000101--breakdown');
    // Same level as the description and the price block: a child of the column, full width.
    expect(anchor?.parentElement).toBe(product.querySelector('[data-testid$="--summary"]'));
    const order = [...(anchor?.parentElement?.children ?? [])].map(testidOf);
    expect(order).toEqual([
      'product-item-id-9000101--description',
      'product-item-id-9000101--title-container',
      'product-item-id-9000101--breakdown',
    ]);
  });

  it('is the fees block of a home feed card too', () => {
    const feed = rootOf(feedCard());
    expect(testidOf(findButtonAnchor(feed))).toBe('feed-item--breakdown');
  });

  it('climbs out of a row that holds the price and the fees', () => {
    const root = rootOf(`
      <div data-testid="product-item-id-9000103">
        <div data-testid="product-item-id-9000103--summary">
          <div data-testid="product-item-id-9000103--description"><p>Marque</p></div>
          <div id="row"><div><p data-testid="product-item-id-9000103--price-text">9,00 €</p></div>
            <div><div data-testid="product-item-id-9000103--breakdown"></div></div></div>
        </div>
      </div>`);
    expect(findButtonAnchor(root)?.id).toBe('row');
  });

  it('follows the price when the card has no fees line', () => {
    const root = rootOf(`
      <div data-testid="product-item-id-9000103">
        <div data-testid="product-item-id-9000103--summary">
          <div data-testid="product-item-id-9000103--description"></div>
          <div id="price"><p data-testid="product-item-id-9000103--price-text">9,00 €</p></div>
        </div>
      </div>`);
    expect(findButtonAnchor(root)?.id).toBe('price');
  });

  it('finds the column even when the price is not in the same summary as the description', () => {
    const root = rootOf(`
      <div data-testid="product-item-id-9000103">
        <div id="text"><div data-testid="product-item-id-9000103--description"></div></div>
        <div id="money"><p data-testid="product-item-id-9000103--price-text">9,00 €</p></div>
      </div>`);
    expect(findButtonAnchor(root)?.id).toBe('money');
  });

  it('is the description when the price is inside it (the older card layout)', () => {
    const root = rootOf(`
      <div data-testid="product-item-id-9000103">
        <div data-testid="product-item-id-9000103--description">
          <p data-testid="product-item-id-9000103--price-text">9,00 €</p>
        </div>
      </div>`);
    expect(testidOf(findButtonAnchor(root))).toBe('product-item-id-9000103--description');
  });

  it('is the description when the card shows no price', () => {
    const root = rootOf(`
      <div data-testid="product-item-id-9000103">
        <div data-testid="product-item-id-9000103--description"></div>
      </div>`);
    expect(testidOf(findButtonAnchor(root))).toBe('product-item-id-9000103--description');
  });

  it('is the description when the price comes before it', () => {
    const root = rootOf(`
      <div data-testid="product-item-id-9000103">
        <p data-testid="product-item-id-9000103--price-text">9,00 €</p>
        <div data-testid="product-item-id-9000103--description"></div>
      </div>`);
    expect(testidOf(findButtonAnchor(root))).toBe('product-item-id-9000103--description');
  });

  it('is null without a description: not a whole card', () => {
    const root = rootOf(`
      <div data-testid="product-item-id-9000103">
        <p data-testid="product-item-id-9000103--price-text">9,00 €</p>
      </div>`);
    expect(findButtonAnchor(root)).toBeNull();
  });
});

describe('findCardRoots', () => {
  it('returns the roots only, whole cards or not', () => {
    const doc = page(
      catalogCard() + catalogCard({ id: '9000102', description: false }) + feedCard(),
    );
    expect(findCardRoots(doc).map((root) => root.getAttribute('data-testid'))).toEqual([
      'product-item-id-9000101',
      'product-item-id-9000102',
      'feed-item',
    ]);
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

describe('findResultsAnchor', () => {
  const rootsOf = (doc: Document) => findCardRoots(doc);

  it('is the grid: the first container that holds every card', () => {
    const doc = page(`
      <main><h1>Résultats</h1><div id="grid" class="feed-grid">
        ${catalogCard({ id: '9000101' })}${catalogCard({ id: '9000102' })}
      </div><nav id="pagination"></nav></main>`);
    expect(findResultsAnchor(rootsOf(doc))?.id).toBe('grid');
  });

  it('is the grid of the FIRST card, whatever blocks of cards follow', () => {
    const doc = page(`
      <main><section id="results">
        <div id="first" class="feed-grid">
          ${catalogCard({ id: '9000101' })}${catalogCard({ id: '9000102' })}
        </div>
        <div id="other"><div class="carousel">${catalogCard({ id: '9000103' })}</div></div>
      </section></main>`);
    expect(findResultsAnchor(rootsOf(doc))?.id).toBe('first');
  });

  it('is the grid of the first card when the page puts one card above and apart', () => {
    const doc = page(`
      <main>
        <section id="top">${catalogCard({ id: '9000101' })}</section>
        <section id="rest">${catalogCard({ id: '9000102' })}${catalogCard({ id: '9000103' })}</section>
      </main>`);
    // The first two cards share only the page: the block that holds the first one.
    expect(findResultsAnchor(rootsOf(doc))?.id).toBe('top');
  });

  it('is the grid of a lone card, not its cell', () => {
    const doc = page(`<main><div id="grid">${catalogCard()}</div></main>`);
    expect(findResultsAnchor(rootsOf(doc))?.id).toBe('grid');
  });

  it('is the block that holds the first card when the cards share only the page', () => {
    const doc = page(`
      <main>
        <section id="first">${feedCard('9000201')}</section>
        <section id="second">${feedCard('9000202')}</section>
      </main>`);
    expect(findResultsAnchor(rootsOf(doc))?.id).toBe('first');
  });

  it('never goes above the page: the body is not a place for the bar either', () => {
    const doc = page(`
      <div id="a">${feedCard('9000201')}</div>
      <div id="b">${feedCard('9000202')}</div>`);
    expect(findResultsAnchor(rootsOf(doc))?.id).toBe('a');
  });

  it('is null without any card', () => {
    expect(findResultsAnchor([])).toBeNull();
  });
});

describe('cardIdOf', () => {
  it('is the id readGridCard reads, for every kind of card', () => {
    const doc = page(catalogCard({ id: '9000101' }) + feedCard('9000201'));
    for (const root of findCardRoots(doc)) {
      expect(cardIdOf(root)).toBe(readGridCard(root)?.id);
    }
    expect(findCardRoots(doc).map(cardIdOf)).toEqual(['9000101', '9000201']);
  });

  it('follows the testid of a recycled root', () => {
    const doc = page(catalogCard({ id: '9000101' }));
    const root = findCardRoots(doc)[0] as Element;
    root.setAttribute('data-testid', 'product-item-id-9000102');
    expect(cardIdOf(root)).toBe('9000102');
  });

  it('is null for what is not a card root, or has no readable item', () => {
    const doc = page(
      `${catalogCard()}<div data-testid="feed-item"><a href="/member/7000001"></a></div>`,
    );
    expect(cardIdOf(doc.body)).toBeNull();
    expect(cardIdOf(doc.querySelector('[data-testid$="--description"]') as Element)).toBeNull();
    expect(cardIdOf(doc.querySelector('[data-testid="feed-item"]') as Element)).toBeNull();
  });
});
