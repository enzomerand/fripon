import { describe, expect, it } from 'vitest';
import type { CheckResult, ImageMatch, Listing } from '../model';
import {
  REVIEW_LIMITS,
  buildReviewInput,
  clampReviewInput,
  isAiReviewInput,
  reviewFingerprint,
  signalLines,
  type AiReviewInput,
} from './input';

const INPUT: AiReviewInput = {
  photoUrl: 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa',
  title: 'Robe fleurie',
  description: 'Robe portée une fois.',
  price: '12,00 €',
  signals: ['Une ligne.', 'Une autre.'],
  fingerprint: ["Recherche d'image : non faite.", 'seller:ok:Normal'],
};

describe('isAiReviewInput', () => {
  it('accepts a well-formed input, with no signal or an empty description', () => {
    expect(isAiReviewInput(INPUT)).toBe(true);
    expect(isAiReviewInput({ ...INPUT, signals: [], description: '' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'input'],
    ['no photo URL', { ...INPUT, photoUrl: undefined }],
    ['a title that is not a string', { ...INPUT, title: 1 }],
    ['a description that is not a string', { ...INPUT, description: null }],
    ['a price that is not a string', { ...INPUT, price: 12 }],
    ['signals that are not a list', { ...INPUT, signals: 'one' }],
    ['a signal that is not a string', { ...INPUT, signals: ['one', 2] }],
    ['no fingerprint', { ...INPUT, fingerprint: undefined }],
    ['a fingerprint that is not a list', { ...INPUT, fingerprint: 'a' }],
    ['a fingerprint line that is not a string', { ...INPUT, fingerprint: ['a', 1] }],
  ])('refuses %s', (_name, value) => {
    expect(isAiReviewInput(value)).toBe(false);
  });
});

describe('clampReviewInput', () => {
  it('leaves an input within the limits as it is', () => {
    expect(clampReviewInput(INPUT)).toEqual(INPUT);
  });

  it('cuts every part to its limit', () => {
    const clamped = clampReviewInput({
      photoUrl: INPUT.photoUrl,
      title: 't'.repeat(REVIEW_LIMITS.title + 50),
      description: 'd'.repeat(REVIEW_LIMITS.description + 500),
      price: 'p'.repeat(REVIEW_LIMITS.price + 10),
      signals: Array.from({ length: REVIEW_LIMITS.signals + 5 }, () =>
        's'.repeat(REVIEW_LIMITS.signal + 100),
      ),
      fingerprint: Array.from({ length: REVIEW_LIMITS.fingerprint + 5 }, () =>
        'f'.repeat(REVIEW_LIMITS.fingerprintLine + 50),
      ),
    });
    expect(clamped.title).toHaveLength(REVIEW_LIMITS.title);
    expect(clamped.description).toHaveLength(1_500);
    expect(clamped.price).toHaveLength(REVIEW_LIMITS.price);
    expect(clamped.signals).toHaveLength(REVIEW_LIMITS.signals);
    expect(clamped.signals.every((line) => line.length === REVIEW_LIMITS.signal)).toBe(true);
    expect(clamped.fingerprint).toHaveLength(REVIEW_LIMITS.fingerprint);
    expect(clamped.fingerprint.every((line) => line.length === REVIEW_LIMITS.fingerprintLine)).toBe(
      true,
    );
  });

  it('never leaves half an emoji at the cut, which Google would refuse as invalid text', () => {
    // 😀 is two UTF-16 units: a cut between them leaves a lone surrogate.
    const text = 'a'.repeat(REVIEW_LIMITS.description - 1) + '😀 et la suite';
    const clamped = clampReviewInput({ ...INPUT, description: text });
    expect(clamped.description).toBe('a'.repeat(REVIEW_LIMITS.description - 1));
    expect(clamped.description.isWellFormed()).toBe(true);
    // An emoji that fits is kept whole.
    const fits = 'a'.repeat(REVIEW_LIMITS.description - 2) + '😀';
    expect(clampReviewInput({ ...INPUT, description: fits }).description).toBe(fits);
  });

  it('drops any field that is not part of the input', () => {
    const sneaky = { ...INPUT, apiKey: 'AIza', extra: [1] } as AiReviewInput;
    expect(Object.keys(clampReviewInput(sneaky)).sort()).toEqual([
      'description',
      'fingerprint',
      'photoUrl',
      'price',
      'signals',
      'title',
    ]);
  });
});

const row = (id: CheckResult['id'], overrides: Partial<CheckResult> = {}): CheckResult => ({
  id,
  status: 'ok',
  tag: 'Rien de notable',
  detail: `Détail ${id}.`,
  signals: [],
  ...overrides,
});

const match = (platform: string, exact: boolean): ImageMatch => ({
  platform,
  url: `https://example.test/${platform}/${exact}`,
  exact,
  price: null,
});

const searched = (matches: ImageMatch[]) =>
  row('image', matches.length === 0 ? { status: 'ok' } : { status: 'bad', matches });

const OFF_IMAGE = row('image', { status: 'off', tag: 'Au clic', detail: 'Lance la recherche.' });

describe('signalLines', () => {
  it('starts with the image search, then the rows that ran, in a fixed order', () => {
    const lines = signalLines([
      searched([]),
      row('price', { status: 'off', tag: 'Non comparé' }),
      row('seller', { tag: 'Normal', detail: 'Vendeur ancien.' }),
      row('photos'),
      row('description', { status: 'warn', tag: 'Style boutique', detail: 'Texte traduit.' }),
    ]);
    expect(lines).toEqual([
      "Recherche d'image : aucune trace de la photo sur Shein, Temu, AliExpress…",
      'Vendeur (Normal) : Vendeur ancien.',
      'Photos (Rien de notable) : Détail photos.',
      'Description (Style boutique) : Texte traduit.',
    ]);
  });

  it('names the platforms where the same photo is on sale, each once', () => {
    const [line] = signalLines([
      searched([
        match('Shein', true),
        match('Shein', true),
        match('Temu', true),
        match('Wish', false),
      ]),
    ]);
    expect(line).toBe("Recherche d'image : la même photo est en vente sur Shein et Temu.");
    expect(
      signalLines([searched([match('Shein', true), match('Temu', true), match('Wish', true)])])[0],
    ).toBe("Recherche d'image : la même photo est en vente sur Shein, Temu et Wish.");
  });

  it('says a lookalike is only that', () => {
    expect(signalLines([searched([match('Temu', false)])])[0]).toBe(
      "Recherche d'image : une photo très proche existe sur Temu.",
    );
  });

  it('says the search was not done whenever it did not run, whatever the reason', () => {
    expect(signalLines([OFF_IMAGE])[0]).toBe("Recherche d'image : non faite.");
    expect(signalLines([row('image', { status: 'off', tag: 'En cours' })])[0]).toBe(
      "Recherche d'image : non faite.",
    );
    expect(signalLines([row('seller')])[0]).toBe("Recherche d'image : non faite.");
  });

  it('says nothing of a row that did not run', () => {
    const lines = signalLines([
      OFF_IMAGE,
      row('seller', { status: 'off', tag: 'Indisponible' }),
      row('photos', { status: 'off', tag: 'Non analysée' }),
      row('description'),
    ]);
    expect(lines).toEqual([
      "Recherche d'image : non faite.",
      'Description (Rien de notable) : Détail description.',
    ]);
  });

  it('is the same for the same rows', () => {
    const rows = [searched([match('Shein', true)]), row('seller'), row('photos')];
    expect(signalLines(rows)).toEqual(signalLines(structuredClone(rows)));
  });
});

describe('reviewFingerprint', () => {
  it('starts with the image line, then the status and tag of each row that ran', () => {
    expect(
      reviewFingerprint([
        searched([match('Shein', true)]),
        row('price', { status: 'off', tag: 'Non comparé' }),
        row('seller', { status: 'warn', tag: 'À surveiller' }),
        row('photos'),
        row('description', { status: 'off', tag: 'Illisible' }),
      ]),
    ).toEqual([
      "Recherche d'image : la même photo est en vente sur Shein.",
      'seller:warn:À surveiller',
      'photos:ok:Rien de notable',
    ]);
  });

  it('does not move with the counts of the detail lines', () => {
    const before = [searched([]), row('seller', { detail: '12 avis, 30 articles.' })];
    const after = [searched([]), row('seller', { detail: '13 avis, 31 articles.' })];
    expect(reviewFingerprint(after)).toEqual(reviewFingerprint(before));
    expect(signalLines(after)).not.toEqual(signalLines(before));
  });

  it('moves when the image search finds something else, even on the same platform count', () => {
    const exact = reviewFingerprint([searched([match('Shein', true)])]);
    expect(reviewFingerprint([searched([match('Temu', true)])])).not.toEqual(exact);
    expect(reviewFingerprint([searched([match('Shein', false)])])).not.toEqual(exact);
    expect(reviewFingerprint([searched([])])).not.toEqual(exact);
    expect(reviewFingerprint([OFF_IMAGE])).toEqual(["Recherche d'image : non faite."]);
  });

  it('is short enough for the limits', () => {
    const rows = [
      searched([match('Shein', true)]),
      row('seller'),
      row('photos'),
      row('description'),
    ];
    const fingerprint = reviewFingerprint(rows);
    expect(fingerprint.length).toBeLessThanOrEqual(REVIEW_LIMITS.fingerprint);
    expect(fingerprint.every((line) => line.length <= REVIEW_LIMITS.fingerprintLine)).toBe(true);
  });
});

describe('buildReviewInput', () => {
  const listing: Listing = {
    id: '100',
    url: 'https://www.vinted.fr/items/100-robe',
    title: 'Robe fleurie',
    description: 'Robe portée deux fois.',
    price: { amount: 12.5, currency: 'EUR' },
    brand: null,
    size: null,
    condition: 'unknown',
    photoUrls: [
      'https://images1.vinted.net/t/main/f800/main.webp?s=m',
      'https://images1.vinted.net/t/2/f800/other.webp?s=m',
    ],
    sellerId: '7000001',
  };

  it('gives the main photo, the text, the price as the buyer reads it and the signals', () => {
    const input = buildReviewInput(listing, [OFF_IMAGE, row('seller')]);
    expect(input).toEqual({
      photoUrl: 'https://images1.vinted.net/t/main/f800/main.webp?s=m',
      title: 'Robe fleurie',
      description: 'Robe portée deux fois.',
      price: expect.stringMatching(/^12,50\s€$/),
      signals: ["Recherche d'image : non faite.", 'Vendeur (Rien de notable) : Détail seller.'],
      fingerprint: ["Recherche d'image : non faite.", 'seller:ok:Rien de notable'],
    });
    expect(isAiReviewInput(input)).toBe(true);
  });

  it('has an empty photo URL for a listing without photos (the page does not ask then)', () => {
    expect(buildReviewInput({ ...listing, photoUrls: [] }, []).photoUrl).toBe('');
  });
});
