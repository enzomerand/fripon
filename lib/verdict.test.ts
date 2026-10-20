import { describe, expect, it } from 'vitest';
import type { CheckId, CheckResult, CheckStatus, ImageMatch, Signal, SignalId } from './model';
import {
  computeVerdict,
  DROPSHIP_PRICE_RATIO,
  MAX_LINES,
  REVIEW_MIN_WEAK_FAMILIES,
  type VerdictInput,
} from './verdict';

const STRONG: SignalId[] = ['stock_multiple_sizes', 'mostly_new_with_tags'];
const WEAK: SignalId[] = [
  'catalog_photo',
  'new_account',
  'few_reviews',
  'photo_reused',
  'marketplace_style_text',
  'no_brand',
];

function check(id: CheckId, status: CheckStatus, signals: Signal[] = []): CheckResult {
  return { id, status, tag: '', detail: '', signals };
}
const strong = (id: SignalId): Signal => ({ id, strength: 'strong' });
const weak = (id: SignalId): Signal => ({ id, strength: 'weak' });

const SHEIN_EXACT: ImageMatch = {
  platform: 'Shein',
  url: 'https://fr.shein.com/p-1.html',
  exact: true,
  price: { amount: 8.99, currency: 'EUR' },
};
const TEMU_EXACT_NO_PRICE: ImageMatch = {
  platform: 'Temu',
  url: 'https://www.temu.com/p-2.html',
  exact: true,
  price: null,
};
const SHEIN_SIMILAR: ImageMatch = { ...SHEIN_EXACT, exact: false, price: null };

/** Checks as the lot would produce them: image ran (ok), the others carry the given signals. */
function input(overrides: Partial<VerdictInput> & { signals?: Signal[]; imageOff?: boolean } = {}) {
  const { signals = [], imageOff = false, ...rest } = overrides;
  return {
    checks: [
      check('image', imageOff ? 'off' : 'ok'),
      check('seller', 'ok', signals),
      check('price', 'off'),
    ],
    imageMatches: [],
    priceRatio: null,
    ...rest,
  } satisfies VerdictInput;
}

describe('thresholds', () => {
  it('are the documented values', () => {
    expect(DROPSHIP_PRICE_RATIO).toBe(2);
    expect(REVIEW_MIN_WEAK_FAMILIES).toBe(2);
    expect(MAX_LINES).toBe(2);
  });
});

describe('dropshipping', () => {
  it.each([
    ['ratio exactly 2', 2],
    ['ratio 3.8', 3.8],
  ])('exact match with %s', (_name, priceRatio) => {
    const verdict = computeVerdict(input({ imageMatches: [SHEIN_EXACT], priceRatio }));
    expect(verdict.level).toBe('dropshipping');
    expect(verdict.title).toBe('Dropshipping probable');
  });

  it('wins over weak or missing signals when the price is at least twice the original', () => {
    expect(computeVerdict(input({ imageMatches: [SHEIN_EXACT], priceRatio: 5 })).level).toBe(
      'dropshipping',
    );
  });

  it.each(STRONG)('exact match, unknown price and the strong signal %s', (id) => {
    const verdict = computeVerdict(
      input({ imageMatches: [TEMU_EXACT_NO_PRICE], signals: [strong(id)] }),
    );
    expect(verdict.level).toBe('dropshipping');
  });

  it('shows the match, the price gap and nothing more than two lines', () => {
    const verdict = computeVerdict(
      input({ imageMatches: [SHEIN_EXACT], priceRatio: 3.8, signals: [strong('catalog_photo')] }),
    );
    expect(verdict.lines.map((l) => l.replace(/\s/g, ' '))).toEqual([
      'Même photo sur Shein à 8,99 €',
      'Vendu ici 3,8× plus cher',
    ]);
  });

  it('puts the strongest signal after the match when the price is unknown', () => {
    const verdict = computeVerdict(
      input({
        imageMatches: [TEMU_EXACT_NO_PRICE],
        signals: [weak('new_account'), strong('catalog_photo')],
      }),
    );
    expect(verdict.lines).toEqual(['Même photo sur Temu', 'Photo type catalogue']);
  });
});

describe('resold (exact match, honest reseller)', () => {
  it('ratio 1.2 and no strong signal', () => {
    const verdict = computeVerdict(input({ imageMatches: [SHEIN_EXACT], priceRatio: 1.2 }));
    expect(verdict.level).toBe('resold');
    expect(verdict.title).toBe('Article Shein revendu');
    expect(verdict.lines.map((l) => l.replace(/\s/g, ' '))).toEqual([
      'Même photo sur Shein à 8,99 €',
      "Prix correct par rapport à l'original",
    ]);
  });

  it('just under the dropshipping ratio', () => {
    expect(computeVerdict(input({ imageMatches: [SHEIN_EXACT], priceRatio: 1.99 })).level).toBe(
      'resold',
    );
  });

  it('a known reasonable price outweighs a strong signal', () => {
    expect(
      computeVerdict(
        input({ imageMatches: [SHEIN_EXACT], priceRatio: 1.2, signals: [strong('catalog_photo')] }),
      ).level,
    ).toBe('resold');
  });

  it('unknown price, no strong signal, even with weak ones', () => {
    const verdict = computeVerdict(
      input({
        imageMatches: [TEMU_EXACT_NO_PRICE],
        signals: [weak('new_account'), weak('few_reviews'), weak('no_brand')],
      }),
    );
    expect(verdict.level).toBe('resold');
    expect(verdict.title).toBe('Article Temu revendu');
  });

  it('names the platform of the cheapest priced exact match', () => {
    const aliexpress: ImageMatch = {
      platform: 'AliExpress',
      url: 'https://aliexpress.com/item/3',
      exact: true,
      price: { amount: 4.5, currency: 'EUR' },
    };
    const verdict = computeVerdict(
      input({ imageMatches: [SHEIN_EXACT, TEMU_EXACT_NO_PRICE, aliexpress], priceRatio: 1.1 }),
    );
    expect(verdict.title).toBe('Article AliExpress revendu');
  });

  it('ignores a ratio that is not a usable number', () => {
    for (const priceRatio of [Number.NaN, Infinity, 0, -1]) {
      expect(computeVerdict(input({ imageMatches: [SHEIN_EXACT], priceRatio })).level).toBe(
        'resold',
      );
    }
    expect(
      computeVerdict(
        input({
          imageMatches: [SHEIN_EXACT],
          priceRatio: Number.NaN,
          signals: [strong('catalog_photo')],
        }),
      ).level,
    ).toBe('dropshipping');
  });
});

describe('review', () => {
  it('a non-exact match alone', () => {
    const verdict = computeVerdict(input({ imageMatches: [SHEIN_SIMILAR] }));
    expect(verdict.level).toBe('review');
    expect(verdict.title).toBe('À vérifier');
    expect(verdict.lines).toEqual(['Photo ressemblante sur Shein']);
  });

  it('a non-exact match never makes a dropshipping verdict, whatever the price', () => {
    expect(computeVerdict(input({ imageMatches: [SHEIN_SIMILAR], priceRatio: 10 })).level).toBe(
      'review',
    );
  });

  it('price_above_similar alone, even weak', () => {
    const verdict = computeVerdict(input({ signals: [weak('price_above_similar')] }));
    expect(verdict.level).toBe('review');
    expect(verdict.lines).toEqual(['Plus cher que les annonces similaires']);
  });

  it.each(STRONG)('the strong signal %s alone', (id) => {
    expect(computeVerdict(input({ signals: [strong(id)] })).level).toBe('review');
  });

  it('weak signals from two distinct families', () => {
    const verdict = computeVerdict(input({ signals: [weak('new_account'), weak('no_brand')] }));
    expect(verdict.level).toBe('review');
    expect(verdict.lines).toEqual(['Vendeur récemment inscrit', 'Aucune marque indiquée']);
  });

  it.each([
    ['profile', ['new_account', 'few_reviews']],
    ['text', ['no_brand', 'marketplace_style_text']],
    ['photo', ['catalog_photo', 'photo_reused']],
  ] as const)('two weak signals of the %s family count as one', (_family, ids) => {
    const verdict = computeVerdict(input({ signals: ids.map(weak) }));
    expect(verdict.level).toBe('clean');
  });

  it('a catalogue photo with a new account is two families', () => {
    expect(
      computeVerdict(input({ signals: [weak('catalog_photo'), weak('new_account')] })).level,
    ).toBe('review');
  });

  it('counts a weak signal reported by two checks once', () => {
    const checks = [
      check('image', 'ok'),
      check('seller', 'warn', [weak('few_reviews')]),
      check('description', 'warn', [weak('few_reviews')]),
    ];
    expect(computeVerdict({ checks, imageMatches: [], priceRatio: null }).level).toBe('clean');
  });

  it('keeps at most two lines, most important first', () => {
    const verdict = computeVerdict(
      input({
        signals: [
          weak('no_brand'),
          strong('stock_multiple_sizes'),
          strong('catalog_photo'),
          weak('new_account'),
        ],
      }),
    );
    expect(verdict.lines).toEqual(['Photo type catalogue', 'Même article en plusieurs tailles']);
  });
});

describe('clean', () => {
  it('nothing found, image search ran', () => {
    const verdict = computeVerdict(input());
    expect(verdict).toEqual({
      level: 'clean',
      title: 'Rien de suspect',
      lines: ['Aucune photo identique trouvée'],
      withoutImageSearch: false,
    });
  });

  it('a single weak signal stays clean and is mentioned', () => {
    const verdict = computeVerdict(input({ signals: [weak('no_brand')] }));
    expect(verdict.level).toBe('clean');
    expect(verdict.lines).toEqual(['Aucune photo identique trouvée', 'Aucune marque indiquée']);
  });

  it.each(WEAK)('the lone weak signal %s does not trigger a review', (id) => {
    expect(computeVerdict(input({ signals: [weak(id)] })).level).toBe('clean');
  });
});

describe('no image search (no key, quota, manual)', () => {
  it('is clean but says so', () => {
    const verdict = computeVerdict(input({ imageOff: true }));
    expect(verdict).toEqual({
      level: 'clean',
      title: "Rien de suspect (sans recherche d'image)",
      lines: ['Photo non recherchée sur Shein, Temu…'],
      withoutImageSearch: true,
    });
  });

  it('still reviews on strong signals and reports the missing search', () => {
    const verdict = computeVerdict(input({ imageOff: true, signals: [strong('catalog_photo')] }));
    expect(verdict.level).toBe('review');
    expect(verdict.title).toBe('À vérifier');
    expect(verdict.withoutImageSearch).toBe(true);
  });

  it('still reviews on two weak signals', () => {
    const verdict = computeVerdict(
      input({ imageOff: true, signals: [weak('new_account'), weak('marketplace_style_text')] }),
    );
    expect(verdict.level).toBe('review');
  });

  it('treats a missing image check as a search that did not run', () => {
    const verdict = computeVerdict({
      checks: [check('seller', 'ok')],
      imageMatches: [],
      priceRatio: null,
    });
    expect(verdict.withoutImageSearch).toBe(true);
    expect(verdict.title).toBe("Rien de suspect (sans recherche d'image)");
  });

  it('a search that ran never claims to be missing', () => {
    expect(
      computeVerdict(input({ imageMatches: [SHEIN_EXACT], priceRatio: 3 })).withoutImageSearch,
    ).toBe(false);
  });
});
