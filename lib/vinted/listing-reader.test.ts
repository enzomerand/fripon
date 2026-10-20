import { describe, expect, it } from 'vitest';
import { itemIdFromUrl, parseAmount, readListing } from './listing-reader';

// Every id, name and URL below is made up.
const URL_OK = 'https://www.vinted.fr/items/9000001-robe-test?referrer=catalog';

const PRODUCT = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Robe de soirée',
  description: 'Robe neuve.\nTaille M.\n',
  image: 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa',
  brand: { '@type': 'Brand', name: 'Marque Test' },
  offers: { '@type': 'Offer', price: 12.5, priceCurrency: 'EUR', itemCondition: 'NewCondition' },
};

function without<T extends object, K extends keyof T>(source: T, key: K): Omit<T, K> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

interface PageOptions {
  jsonLd?: unknown;
  status?: string;
  size?: string;
  sellerHref?: string | null;
  photos?: string[];
  priceText?: string;
  rsc?: unknown[];
  heading?: string;
}

function rscScript(chunk: string): string {
  const payload = JSON.stringify([1, chunk]).replace(/<\/script/g, '<\\/script');
  return `<script>self.__next_f.push(${payload})</script>`;
}

function page(options: PageOptions = {}): Document {
  const {
    jsonLd = PRODUCT,
    status = 'Neuf avec étiquette',
    size = 'M',
    sellerHref = '/member/7000001',
    photos = [
      'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa',
      'https://images1.vinted.net/t/01_b/f800/second.webp?s=bb',
    ],
    priceText = '12,50 €',
    rsc = [],
    heading = 'Robe de soirée',
  } = options;
  const html = `
    ${jsonLd === null ? '' : `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`}
    <h1 data-testid="legacy">Autre titre</h1>
    <div data-testid="item-page-summary-plugin"><h1>${heading}</h1></div>
    <div class="details-list--pricing"><span data-testid="item-price">${priceText}</span></div>
    <div data-testid="item-attributes-status"><div>État</div><div><span itemprop="status">${status}</span></div></div>
    <div data-testid="item-attributes-size_familiar"><div>Taille</div><div>${size}</div></div>
    ${sellerHref === null ? '' : `<a href="${sellerHref}"><span data-testid="profile-username">vendeuse_test</span></a>`}
    ${photos
      .map(
        (src, i) =>
          `<div data-testid="item-photo-${i + 1}"><img data-testid="item-photo-${i + 1}--img" src="${src}"></div>`,
      )
      .join('')}
    <img data-testid="similar_items-1--image--img" src="https://images1.vinted.net/t/zz/310x430/other.webp">
    ${rsc.map((chunk) => rscScript(String(chunk))).join('')}`;
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = html;
  return doc;
}

describe('itemIdFromUrl', () => {
  it('reads the id from slugged and slug-less item URLs', () => {
    expect(itemIdFromUrl('https://www.vinted.fr/items/9000001-robe-test?x=1')).toBe('9000001');
    expect(itemIdFromUrl('https://www.vinted.de/items/9000001')).toBe('9000001');
  });

  it('is null for any other page', () => {
    expect(itemIdFromUrl('https://www.vinted.fr/catalog?search_text=robe')).toBeNull();
    expect(itemIdFromUrl('https://www.vinted.fr/member/7000001')).toBeNull();
    expect(itemIdFromUrl('https://www.vinted.fr/items/12abc')).toBeNull();
    expect(itemIdFromUrl('not a url')).toBeNull();
  });
});

describe('parseAmount', () => {
  it('parses European and plain notations', () => {
    expect(parseAmount('4,50 €')).toBe(4.5);
    expect(parseAmount('4,50 €')).toBe(4.5);
    expect(parseAmount('1 234,50 €')).toBe(1234.5);
    expect(parseAmount('1.234,50')).toBe(1234.5);
    expect(parseAmount('1.234')).toBe(1234);
    expect(parseAmount('4.5')).toBe(4.5);
    expect(parseAmount('12 €')).toBe(12);
  });

  it('is null without digits', () => {
    expect(parseAmount('gratuit')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
});

describe('readListing from JSON-LD and the DOM', () => {
  it('builds the whole listing', () => {
    expect(readListing(page(), URL_OK)).toEqual({
      id: '9000001',
      url: URL_OK,
      title: 'Robe de soirée',
      description: 'Robe neuve.\nTaille M.',
      price: { amount: 12.5, currency: 'EUR' },
      brand: 'Marque Test',
      size: 'M',
      condition: 'new_with_tags',
      photoUrls: [
        'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa',
        'https://images1.vinted.net/t/01_b/f800/second.webp?s=bb',
      ],
      sellerId: '7000001',
    });
  });

  it('passes a "no brand" placeholder through untouched', () => {
    const listing = readListing(
      page({ jsonLd: { ...PRODUCT, brand: { '@type': 'Brand', name: 'Sans marque' } } }),
      URL_OK,
    );
    expect(listing?.brand).toBe('Sans marque');
  });

  it('accepts a plain string brand, and a missing one as null', () => {
    expect(readListing(page({ jsonLd: { ...PRODUCT, brand: 'Autre' } }), URL_OK)?.brand).toBe(
      'Autre',
    );
    const noBrand = without(PRODUCT, 'brand');
    expect(readListing(page({ jsonLd: noBrand }), URL_OK)?.brand).toBeNull();
  });

  it('finds the Product inside an @graph array and an offers array', () => {
    const jsonLd = {
      '@graph': [
        { '@type': 'WebPage' },
        { ...PRODUCT, offers: [{ price: '9.9', priceCurrency: 'EUR' }] },
      ],
    };
    const listing = readListing(page({ jsonLd }), URL_OK);
    expect(listing?.price).toEqual({ amount: 9.9, currency: 'EUR' });
  });

  it('orders gallery photos by index and ignores other cards', () => {
    const doc = page({ photos: [] });
    doc.body.insertAdjacentHTML(
      'beforeend',
      `<img data-testid="item-photo-2--img" src="https://images1.vinted.net/t/b/f800/b.webp?s=2">
       <img data-testid="item-photo-1--img" src="/t/a/f800/a.webp?s=1">`,
    );
    const listing = readListing(doc, URL_OK);
    expect(listing?.photoUrls).toEqual([
      'https://www.vinted.fr/t/a/f800/a.webp?s=1',
      'https://images1.vinted.net/t/b/f800/b.webp?s=2',
    ]);
  });

  it('falls back on the JSON-LD image when the gallery is empty', () => {
    const listing = readListing(page({ photos: [] }), URL_OK);
    expect(listing?.photoUrls).toEqual(['https://images1.vinted.net/t/01_a/f800/main.webp?s=aa']);
  });

  it('keeps an empty photo list rather than failing', () => {
    const noImage = without(PRODUCT, 'image');
    expect(readListing(page({ photos: [], jsonLd: noImage }), URL_OK)?.photoUrls).toEqual([]);
  });

  it('reads the condition from several labels and falls back to unknown', () => {
    expect(readListing(page({ status: 'Très bon état' }), URL_OK)?.condition).toBe('very_good');
    expect(readListing(page({ status: 'New without tags' }), URL_OK)?.condition).toBe(
      'new_without_tags',
    );
    expect(readListing(page({ status: 'Pristine' }), URL_OK)?.condition).toBe('unknown');
  });

  it('uses the DOM title and price when JSON-LD is missing', () => {
    const listing = readListing(page({ jsonLd: null }), URL_OK);
    expect(listing?.title).toBe('Robe de soirée');
    expect(listing?.price).toEqual({ amount: 12.5, currency: 'EUR' });
    expect(listing?.description).toBe('');
  });

  it('is null for a non-item URL', () => {
    expect(readListing(page(), 'https://www.vinted.fr/catalog')).toBeNull();
  });

  it('is null while the seller is not there yet', () => {
    expect(readListing(page({ sellerHref: null }), URL_OK)).toBeNull();
  });

  it('is null without any price', () => {
    const noOffers = without(PRODUCT, 'offers');
    expect(readListing(page({ jsonLd: noOffers, priceText: 'bientôt' }), URL_OK)).toBeNull();
  });
});

describe('readListing RSC fallback', () => {
  const photos = [
    { id: 2, is_main: false, url: 'https://images1.vinted.net/t/02/f800/two.webp?s=2' },
    { id: 1, is_main: true, url: 'https://images1.vinted.net/t/01/f800/one.webp?s=1' },
  ];
  const flight = [
    '0:{"a":1}\n',
    `1b:["$","div",null,{"itemId":9000001,"sellerId":7000001}]\n2:{"item_id":"9000001","title":"Robe, \\"de\\" soirée","photos":${JSON.stringify(photos)},"attributes":[{"code":"brand","data":{"value":"Marque RSC"}},{"code":"size_familiar","data":{"value":"L"}},{"code":"status","data":{"value":"Neuf avec étiquette"}}]}\n`,
  ];

  it('finds the seller, photos and attributes when the DOM has none', () => {
    const doc = page({
      jsonLd: null,
      sellerHref: null,
      photos: [],
      status: '',
      size: '',
      rsc: [flight[0], flight[1]],
    });
    const listing = readListing(doc, URL_OK);
    expect(listing).toMatchObject({
      sellerId: '7000001',
      brand: 'Marque RSC',
      size: 'L',
      condition: 'new_with_tags',
      photoUrls: [
        'https://images1.vinted.net/t/01/f800/one.webp?s=1',
        'https://images1.vinted.net/t/02/f800/two.webp?s=2',
      ],
    });
  });

  it('reassembles a value split over several chunks', () => {
    const joined = flight.join('');
    const cut = joined.indexOf('"photos"') + 20;
    const doc = page({
      jsonLd: null,
      sellerHref: null,
      photos: [],
      rsc: [joined.slice(0, cut), joined.slice(cut)],
    });
    expect(readListing(doc, URL_OK)?.photoUrls).toHaveLength(2);
  });

  it('falls back on seller_id when the page props are not there', () => {
    const doc = page({
      sellerHref: null,
      rsc: ['x:{"seller_id":"7000009","name":"vendeuse_test"}\n'],
    });
    expect(readListing(doc, URL_OK)?.sellerId).toBe('7000009');
  });

  it('survives malformed scripts', () => {
    const doc = page({ sellerHref: null, rsc: ['not json at all', 'y:{"seller_id":"7000009"}\n'] });
    doc.body.insertAdjacentHTML('beforeend', '<script>self.__next_f.push(oops)</script>');
    expect(readListing(doc, URL_OK)?.sellerId).toBe('7000009');
  });
});
