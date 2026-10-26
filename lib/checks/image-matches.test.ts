import { describe, expect, it } from 'vitest';
import type { WebDetection, WebPage } from '../google/vision';
import { MAX_IMAGE_MATCHES, parseWebDetection, platformOfHost } from './image-matches';

const IMG = [{ url: 'https://img.example.test/a.jpg' }];

/** A page Google found the whole photo on. */
const full = (url: string) => ({ url, pageTitle: 'Titre', fullMatchingImages: IMG });
/** A page that only shares a piece of the photo. */
const partial = (url: string) => ({ url, pageTitle: 'Titre', partialMatchingImages: IMG });

const detect = (...pages: WebPage[]): WebDetection => ({
  pagesWithMatchingImages: pages,
});

describe('platformOfHost', () => {
  it.each([
    ['shein.com', 'Shein'],
    ['fr.shein.com', 'Shein'],
    ['eur.shein.com', 'Shein'],
    ['m.shein.com', 'Shein'],
    ['shein.co.uk', 'Shein'],
    ['www.shein.com.mx', 'Shein'],
    ['SHEIN.SE', 'Shein'],
    ['fr.romwe.com', 'Romwe'],
    ['www.temu.com', 'Temu'],
    ['fr.aliexpress.com', 'AliExpress'],
    ['aliexpress.us', 'AliExpress'],
    ['www.alibaba.com', 'Alibaba'],
    ['www.dhgate.com', 'DHgate'],
    ['www.wish.com', 'Wish'],
    ['fr.zaful.com', 'Zaful'],
    ['www.banggood.com', 'Banggood'],
    ['shein.com.', 'Shein'],
  ])('knows %s as %s', (host, name) => {
    expect(platformOfHost(host)?.name).toBe(name);
  });

  it.each([
    'shein.someblog.com',
    'shein.com.evil.com',
    'shein.co.uk.evil.co.uk',
    'wishlist.com',
    'notshein.com',
    'sheinfan.fr',
    'shein.shop',
    'shein.top',
    'shein',
    'com',
    'wish.shein.evil.com',
    'www.vinted.fr',
    'www.leboncoin.fr',
    'www.pinterest.com',
    'www.youtube.com',
    '',
  ])('does not know %s', (host) => {
    expect(platformOfHost(host)).toBeUndefined();
  });

  it('reads the registrable label, so a platform name in a subdomain does not count', () => {
    expect(platformOfHost('shein.wish.com')?.name).toBe('Wish');
    expect(platformOfHost('wish.shein.com')?.name).toBe('Shein');
  });
});

describe('parseWebDetection platforms', () => {
  it('keeps the allowed platforms and ignores everything else', () => {
    const matches = parseWebDetection(
      detect(
        full('https://fr.shein.com/Robe-Test-p-1234567-cat-1727.html'),
        full('https://www.vinted.fr/items/1-robe'),
        full('https://www.pinterest.com/pin/123/'),
        full('https://www.youtube.com/watch?v=abc'),
        full('https://www.amazon.fr/dp/B000000000'),
        full('https://www.instagram.com/p/abc/'),
        full('https://shein.someblog.com/post-p-1234567'),
        full('https://wishlist.com/product/1'),
        full('https://www.leboncoin.fr/vetements/123.htm'),
      ),
    );
    expect(matches).toEqual([
      {
        platform: 'Shein',
        url: 'https://fr.shein.com/Robe-Test-p-1234567-cat-1727.html',
        exact: true,
        price: null,
      },
    ]);
  });

  it('names each platform', () => {
    const matches = parseWebDetection(
      detect(
        full('https://fr.shein.com/Robe-p-1.html'),
        full('https://fr.romwe.com/Robe-p-2.html'),
        full('https://www.temu.com/robe-g-601099.html'),
        full('https://fr.aliexpress.com/item/1005001.html'),
        full('https://www.alibaba.com/product-detail/Robe_100.html'),
        full('https://www.dhgate.com/product/robe/100.html'),
        full('https://www.wish.com/product/abc'),
        full('https://fr.zaful.com/robe-p_300.html'),
        full('https://www.banggood.com/Robe-p-400.html'),
      ),
    );
    expect(matches.map((m) => m.platform)).toEqual([
      'Shein',
      'Romwe',
      'Temu',
      'AliExpress',
      'Alibaba',
      'DHgate',
      'Wish',
      'Zaful',
      'Banggood',
    ]);
    expect(matches.every((m) => m.exact && m.price === null)).toBe(true);
  });

  it('ignores a URL that is not http(s) or cannot be parsed', () => {
    const matches = parseWebDetection({
      pagesWithMatchingImages: [
        full('javascript://fr.shein.com/%0Aalert(1)-p-1'),
        full('ftp://fr.shein.com/Robe-p-1.html'),
        full('not a url'),
        { pageTitle: 'sans lien', fullMatchingImages: IMG },
        full('http://fr.shein.com/Robe-p-2.html'),
      ],
    });
    expect(matches.map((m) => m.url)).toEqual(['http://fr.shein.com/Robe-p-2.html']);
  });
});

describe('parseWebDetection exact matches', () => {
  it.each([
    ['https://fr.shein.com/Robe-Fleurie-p-12345678-cat-1727.html'],
    ['https://eur.shein.com/Top-p-9.html'],
    ['https://fr.romwe.com/Top-p-9.html'],
    ['https://www.banggood.com/Top-p-9.html'],
    ['https://www.temu.com/fr/robe-g-601099512345678.html'],
    ['https://www.temu.com/goods.html?goods_id=601099'],
    ['https://fr.aliexpress.com/item/1005005123456789.html'],
    ['https://www.alibaba.com/product-detail/Robe-femme_1600123.html'],
    ['https://www.dhgate.com/product/robe-femme/123456789.html'],
    ['https://www.wish.com/product/5c1234abcd'],
    ['https://fr.zaful.com/robe-p_1234567.html'],
  ])('is exact for a full match on the product page %s', (url) => {
    expect(parseWebDetection(detect(full(url)))[0]?.exact).toBe(true);
  });

  it('is not exact without a full match on the page', () => {
    const matches = parseWebDetection(detect(partial('https://fr.shein.com/Robe-p-1.html')));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ platform: 'Shein', exact: false });
  });

  it('is not exact when the full matches list is empty', () => {
    const page = { url: 'https://fr.shein.com/Robe-p-1.html', fullMatchingImages: [] };
    expect(parseWebDetection(detect(page))[0]?.exact).toBe(false);
  });

  it.each([
    ['https://fr.shein.com/style/Robes-sc-00101597.html'],
    ['https://fr.shein.com/Robes-c-1727.html'],
    ['https://fr.aliexpress.com/w/wholesale-robe.html'],
    ['https://www.temu.com/fr/robes-femme-s-1234.html'],
    ['https://www.alibaba.com/trade/search?SearchText=robe'],
    ['https://fr.zaful.com/robes-c_100.html'],
    ['https://www.dhgate.com/wholesale/robe.html'],
    ['https://www.shein.com/'],
  ])('is not exact for the category or search page %s, even with a full match', (url) => {
    const matches = parseWebDetection(detect(full(url)));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.exact).toBe(false);
  });

  it('looks at the path, not at the query string', () => {
    const matches = parseWebDetection(detect(full('https://fr.shein.com/category?ref=x-p-12345')));
    expect(matches[0]?.exact).toBe(false);
  });

  it('reads the whole-photo flag of the page, not the top-level image lists', () => {
    const matches = parseWebDetection({
      fullMatchingImages: IMG,
      pagesWithMatchingImages: [{ url: 'https://fr.shein.com/Robe-p-1.html' }],
    });
    expect(matches[0]?.exact).toBe(false);
  });
});

describe('parseWebDetection ordering', () => {
  it('puts exact matches first and keeps Google order inside each group', () => {
    const matches = parseWebDetection(
      detect(
        partial('https://fr.shein.com/A-p-1.html'),
        full('https://fr.shein.com/B-p-2.html'),
        partial('https://www.temu.com/c-g-3.html'),
        full('https://fr.romwe.com/D-p-4.html'),
        full('https://fr.shein.com/style/E-sc-5.html'),
      ),
    );
    expect(matches.map((m) => [m.url.split('/').pop(), m.exact])).toEqual([
      ['B-p-2.html', true],
      ['D-p-4.html', true],
      ['A-p-1.html', false],
      ['c-g-3.html', false],
      ['E-sc-5.html', false],
    ]);
  });

  it('merges a URL that comes twice, exact if any of them is', () => {
    const url = 'https://fr.shein.com/Robe-p-1.html';
    const matches = parseWebDetection(detect(partial(url), full(url), full(`${url}#reviews`)));
    expect(matches).toEqual([{ platform: 'Shein', url, exact: true, price: null }]);
  });

  it('keeps at most 10 matches, exact ones first', () => {
    const pages = [
      ...Array.from({ length: 8 }, (_, i) => partial(`https://fr.shein.com/Sim-${i}-p-${i}.html`)),
      ...Array.from({ length: 6 }, (_, i) => full(`https://eur.shein.com/Ex-${i}-p-${i}.html`)),
    ];
    const matches = parseWebDetection(detect(...pages));
    expect(matches).toHaveLength(MAX_IMAGE_MATCHES);
    expect(matches.filter((m) => m.exact)).toHaveLength(6);
    expect(matches.slice(0, 6).every((m) => m.exact)).toBe(true);
  });
});

describe('parseWebDetection empty answers', () => {
  it('returns nothing when Google found nothing', () => {
    expect(parseWebDetection({})).toEqual([]);
    expect(parseWebDetection({ pagesWithMatchingImages: [] })).toEqual([]);
  });

  it('returns nothing when only unrelated sites match', () => {
    expect(
      parseWebDetection(
        detect(full('https://www.pinterest.fr/pin/1/'), partial('https://x.test/')),
      ),
    ).toEqual([]);
  });
});
