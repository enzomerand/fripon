import { describe, expect, it } from 'vitest';
import type { Condition, Seller, SellerItem } from '../model';
import { checkSeller, hasStockPattern, normalizeTitle } from './seller';

function item(
  n: number,
  overrides: Partial<SellerItem> = {},
  condition: Condition = 'good',
): SellerItem {
  return {
    id: String(n),
    title: `Article numéro ${n} très particulier`,
    condition,
    size: 'M',
    brand: null,
    photoUrl: null,
    ...overrides,
  };
}

function seller(overrides: Partial<Seller> = {}): Seller {
  return {
    id: 's1',
    feedbackCount: 120,
    itemCount: 3,
    items: [item(1), item(2), item(3)],
    ...overrides,
  };
}

const ids = (s: Seller) => checkSeller(s).signals.map((x) => x.id);

describe('normalizeTitle', () => {
  it('removes accents, punctuation and size mentions', () => {
    expect(normalizeTitle('Robe Fleurie - Taille M', 'M')).toBe('robe fleurie');
    expect(normalizeTitle('Robe fleurie T.38', '38')).toBe('robe fleurie');
    expect(normalizeTitle('Robe fleurie (XL)', 'XL')).toBe('robe fleurie');
    expect(normalizeTitle('Top été size S', null)).toBe('top ete');
  });

  it('keeps model numbers', () => {
    expect(normalizeTitle('Nike Air Max 90', '42')).toBe('nike air max 90');
  });
});

describe('checkSeller signals', () => {
  it('is reassuring for an old, well-reviewed, varied wardrobe', () => {
    const result = checkSeller(seller());
    expect(result.id).toBe('seller');
    expect(result.status).toBe('ok');
    expect(result.tag).toBe('Rassurant');
    expect(result.signals).toEqual([]);
  });

  it('flags few reviews (weak) only below 5', () => {
    expect(ids(seller({ feedbackCount: 4 }))).toEqual(['few_reviews']);
    expect(ids(seller({ feedbackCount: 5 }))).toEqual([]);
  });

  it('flags mostly new with tags (strong) from 10 items and 60 %', () => {
    const make = (nwt: number, total: number) =>
      seller({
        itemCount: total,
        items: Array.from({ length: total }, (_, i) =>
          item(i, {}, i < nwt ? 'new_with_tags' : 'good'),
        ),
      });
    expect(ids(make(6, 10))).toEqual(['mostly_new_with_tags']);
    expect(ids(make(5, 10))).toEqual([]);
    // Too small a sample to mean anything.
    expect(ids(make(5, 5))).toEqual([]);
  });

  it('flags the same branded article in two sizes (strong)', () => {
    const items = [
      item(1, { title: 'Robe fleurie été Taille S', size: 'S', brand: 'Zara' }),
      item(2, { title: 'Robe fleurie été taille M', size: 'M', brand: 'Zara' }),
    ];
    expect(ids(seller({ items, itemCount: 2 }))).toEqual(['stock_multiple_sizes']);
  });

  it('flags the same branded article listed three times (strong)', () => {
    const items = [1, 2, 3].map((n) =>
      item(n, { title: 'Robe fleurie été', size: 'M', brand: 'Zara' }),
    );
    expect(ids(seller({ items, itemCount: 3 }))).toEqual(['stock_multiple_sizes']);
  });

  it('does not flag two copies in the same size, nor generic one-word titles', () => {
    const twins = [1, 2].map((n) => item(n, { title: 'Robe fleurie été', size: 'M' }));
    expect(ids(seller({ items: twins, itemCount: 2 }))).toEqual([]);
    const generic = [1, 2, 3].map((n) => item(n, { title: 'Robe', size: ['S', 'M', 'L'][n - 1]! }));
    expect(hasStockPattern(generic)).toBe(false);
  });

  it('does not mix different articles of the same sizes', () => {
    const items = [
      item(1, { title: 'Robe fleurie', size: 'S' }),
      item(2, { title: 'Robe unie', size: 'M' }),
      item(3, { title: 'Jean slim', size: 'L' }),
    ];
    expect(hasStockPattern(items)).toBe(false);
  });
});

describe('stock pattern needs a second clue', () => {
  const sizes = (brandA: string | null, brandB: string | null) => [
    item(1, { title: 'Robe fleurie été Taille S', size: 'S', brand: brandA }),
    item(2, { title: 'Robe fleurie été taille M', size: 'M', brand: brandB }),
  ];
  const HASH = 0x0f0f_f0f0_1234_abcdn;

  it('does not flag two sizes of an article without brand or photo evidence', () => {
    expect(hasStockPattern(sizes(null, null))).toBe(false);
    expect(hasStockPattern(sizes('Zara', 'Mango'))).toBe(false);
    expect(hasStockPattern(sizes('Sans marque', 'Sans marque'))).toBe(false);
  });

  it('accepts the same brand whatever the case or accents', () => {
    expect(hasStockPattern(sizes('Zara', ' zara '))).toBe(true);
    expect(hasStockPattern(sizes('Éram', 'ERAM'))).toBe(true);
  });

  it('accepts near-identical main photos instead of a brand', () => {
    const hashes = [
      { itemId: '1', hash: HASH },
      { itemId: '2', hash: HASH ^ 0b111n }, // 3 bits apart
    ];
    expect(hasStockPattern(sizes(null, null), hashes)).toBe(true);
  });

  it('rejects photos that differ by more than 3 bits, unknown hashes and flat pictures', () => {
    expect(
      hasStockPattern(sizes(null, null), [
        { itemId: '1', hash: HASH },
        { itemId: '2', hash: HASH ^ 0b1111n },
      ]),
    ).toBe(false);
    expect(hasStockPattern(sizes(null, null), [{ itemId: '1', hash: HASH }])).toBe(false);
    expect(
      hasStockPattern(sizes(null, null), [
        { itemId: '1', hash: 0n },
        { itemId: '2', hash: 0n },
      ]),
    ).toBe(false);
  });

  it('reaches checkSeller through the photo hashes argument', () => {
    const items = sizes(null, null);
    const hashes = [
      { itemId: '1', hash: HASH },
      { itemId: '2', hash: HASH },
    ];
    expect(checkSeller(seller({ items, itemCount: 2 })).signals).toEqual([]);
    expect(checkSeller(seller({ items, itemCount: 2 }), hashes).signals).toEqual([
      { id: 'stock_multiple_sizes', strength: 'strong' },
    ]);
  });

  it('needs three meaningful words in the title', () => {
    const two = [
      item(1, { title: 'Robe fleurie', size: 'S', brand: 'Zara' }),
      item(2, { title: 'Robe fleurie', size: 'M', brand: 'Zara' }),
    ];
    expect(hasStockPattern(two)).toBe(false);
    // Small words and numbers do not count as meaningful.
    const padded = [
      item(1, { title: 'Robe de la 38', size: 'S', brand: 'Zara' }),
      item(2, { title: 'Robe de la 38', size: 'M', brand: 'Zara' }),
    ];
    expect(hasStockPattern(padded)).toBe(false);
  });
});

describe('checkSeller when Vinted data is missing', () => {
  it('has no review signal and no review sentence without a review count', () => {
    const result = checkSeller(seller({ feedbackCount: null }));
    expect(result.signals).toEqual([]);
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('3 articles en vente.');
    // Zero is a real count, null is not.
    expect(ids(seller({ feedbackCount: 0 }))).toEqual(['few_reviews']);
  });

  it('flags the analysis as partial when most conditions are unknown, and never says Rassurant', () => {
    const items = Array.from({ length: 6 }, (_, i) => item(i, {}, i < 4 ? 'unknown' : 'good'));
    const result = checkSeller(seller({ items, itemCount: 6 }));
    expect(result.status).toBe('ok');
    expect(result.tag).toBe("Peu d'infos");
    expect(result.detail).toBe('120 avis. 6 articles en vente. État des articles non analysé.');
  });

  it('does not flag exactly half unknown', () => {
    const items = Array.from({ length: 6 }, (_, i) => item(i, {}, i < 3 ? 'unknown' : 'good'));
    const result = checkSeller(seller({ items, itemCount: 6 }));
    expect(result.tag).toBe('Rassurant');
    expect(result.detail).not.toContain('non analysé');
  });

  it('keeps À surveiller, and the note, when signals exist', () => {
    const items = Array.from({ length: 6 }, () => item(1, {}, 'unknown'));
    const result = checkSeller(seller({ items, itemCount: 6, feedbackCount: 2 }));
    expect(result.status).toBe('warn');
    expect(result.tag).toBe('À surveiller');
    expect(result.detail).toContain('État des articles non analysé.');
  });
});

describe('checkSeller status and wording', () => {
  it('is warn with only weak signals', () => {
    const result = checkSeller(seller({ feedbackCount: 3 }));
    expect(result.status).toBe('warn');
    expect(result.tag).toBe('À surveiller');
    expect(result.detail).toBe('3 avis. 3 articles en vente.');
  });

  it('is bad with one strong signal and builds the detail from the data', () => {
    const items = Array.from({ length: 41 }, (_, i) =>
      item(
        i,
        { title: `Robe fleurie modèle ${i % 8}`, size: i % 2 ? 'S' : 'M', brand: 'Zara' },
        i < 38 ? 'new_with_tags' : 'good',
      ),
    );
    const result = checkSeller(seller({ feedbackCount: 3, itemCount: 41, items }));
    expect(result.status).toBe('bad');
    expect(result.tag).toBe('À surveiller');
    expect(result.detail).toBe(
      '3 avis. 41 articles en vente dont 38 « neufs avec étiquette », souvent en plusieurs tailles.',
    );
  });

  it('gives a share when the sample is smaller than the wardrobe', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      item(i, {}, i < 18 ? 'new_with_tags' : 'good'),
    );
    const result = checkSeller(seller({ itemCount: 200, items }));
    expect(result.detail).toContain(
      '200 articles en vente dont environ 90 % « neufs avec étiquette »',
    );
  });

  it('omits unknown parts and handles singular and zero', () => {
    const result = checkSeller(
      seller({
        feedbackCount: 0,
        itemCount: 1,
        items: [item(1, {}, 'new_with_tags')],
      }),
    );
    expect(result.detail).toBe('Aucun avis. 1 article en vente dont 1 « neuf avec étiquette ».');
    const empty = checkSeller(seller({ itemCount: 0, items: [], feedbackCount: 1 }));
    expect(empty.detail).toBe('1 avis. Aucun article en vente.');
  });
});
