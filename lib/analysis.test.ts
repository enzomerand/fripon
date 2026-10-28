import { describe, expect, it, vi } from 'vitest';
import {
  AnalysisCancelledError,
  askAiReview,
  capLocalHeuristics,
  IMAGE_CONCURRENCY,
  MAX_OTHER_PHOTOS,
  analyzeListing,
  searchPhoto,
  withAiReview,
  withImageSearch,
  type AiDeps,
  type AnalysisDeps,
  type SearchDeps,
} from './analysis';
import { imageCheckOff, imageCheckSearching } from './checks/image';
import { hashToHex } from './image/pixels';
import type { AiReviewResponse, SearchImageResponse } from './messages';
import type { CheckResult, ImageMatch, Listing, Seller, SellerItem } from './model';

const listing: Listing = {
  id: '100',
  url: 'https://www.vinted.fr/items/100-robe',
  title: 'Robe fleurie',
  description: "Jolie robe portée deux fois, taille correcte, achetée l'été dernier.",
  price: { amount: 12, currency: 'EUR' },
  brand: 'Zara',
  size: 'M',
  condition: 'very_good',
  photoUrls: ['https://images1.vinted.net/t/main/f800/main.webp?s=m'],
  sellerId: '7000001',
};

const item = (n: number, overrides: Partial<SellerItem> = {}): SellerItem => ({
  id: String(n),
  title: `Article très particulier numéro ${n}`,
  condition: 'good',
  size: 'M',
  brand: null,
  photoUrl: `https://images1.vinted.net/t/${n}/f800/p.webp?s=${n}`,
  ...overrides,
});

const seller = (items: SellerItem[]): Seller => ({
  id: '7000001',
  feedbackCount: 80,
  itemCount: items.length,
  items,
});

/** Far-apart hashes, one per photo, so no two photos count as the same picture. */
const distinctHash = (n: number) => hashToHex(BigInt(n) * 0x0123456789abcdfn);
const fastHash = '0f0f0f0f0f0f0f0f';

function deps(overrides: Partial<AnalysisDeps> = {}): AnalysisDeps {
  return {
    fetchSeller: vi.fn(() => Promise.resolve(seller([item(1), item(2), item(3)]))),
    analyzeImage: vi.fn((url: string) =>
      Promise.resolve({
        ok: true as const,
        hash: url.includes('/main/') ? fastHash : distinctHash(url.length * 7919),
        catalogScore: 0.2,
      }),
    ),
    ...overrides,
  };
}

const exactMatch: ImageMatch = {
  platform: 'Shein',
  url: 'https://fr.shein.com/Robe-Test-p-1234567-cat-1727.html',
  exact: true,
  price: null,
};
const similarMatch: ImageMatch = {
  platform: 'Temu',
  url: 'https://www.temu.com/robe-g-601099512345678.html',
  exact: false,
  price: null,
};
const found = (...matches: ImageMatch[]): SearchImageResponse => ({ status: 'ok', matches });

describe('analyzeListing', () => {
  it('returns the checks in display order with the image and price off', async () => {
    const { checks, verdict } = await analyzeListing(listing, deps());

    expect(checks.map((c) => c.id)).toEqual(['image', 'price', 'seller', 'photos', 'description']);
    expect(checks[0]).toMatchObject({ id: 'image', status: 'off', tag: 'Désactivée' });
    expect(checks[1]).toMatchObject({ id: 'price', status: 'off' });
    expect(checks[2]?.status).toBe('ok');
    expect(checks[3]).toMatchObject({ id: 'photos', status: 'ok' });
    expect(verdict.level).toBe('clean');
    expect(verdict.withoutImageSearch).toBe(true);
  });

  it('analyses the main photo and the seller photos, never the current item', async () => {
    const d = deps({
      fetchSeller: () => Promise.resolve(seller([item(1), item(100), item(2)])),
    });
    await analyzeListing(listing, d);

    const urls = vi.mocked(d.analyzeImage).mock.calls.map((call) => call[0]);
    expect(urls[0]).toBe(listing.photoUrls[0]);
    expect(urls).toHaveLength(3);
    expect(urls.some((url) => url.includes('/100/'))).toBe(false);
  });

  it('caps the seller photos and runs at most four analyses at a time', async () => {
    const items = Array.from({ length: 40 }, (_, i) => item(i + 1));
    let running = 0;
    let peak = 0;
    const d = deps({
      fetchSeller: () => Promise.resolve(seller(items)),
      analyzeImage: vi.fn(async (url: string) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
        return { ok: true as const, hash: distinctHash(url.length), catalogScore: 0.1 };
      }),
    });
    await analyzeListing(listing, d);

    expect(vi.mocked(d.analyzeImage)).toHaveBeenCalledTimes(1 + MAX_OTHER_PHOTOS);
    expect(peak).toBe(IMAGE_CONCURRENCY);
  });

  it('skips seller items without a photo', async () => {
    const d = deps({
      fetchSeller: () => Promise.resolve(seller([item(1, { photoUrl: null }), item(2)])),
    });
    await analyzeListing(listing, d);
    expect(vi.mocked(d.analyzeImage)).toHaveBeenCalledTimes(2);
  });

  it('flags a catalogue-looking main photo reused by the seller, as one family of hints', async () => {
    const reused = item(2, { photoUrl: 'https://images1.vinted.net/t/main/f800/copy.webp?s=2' });
    const d = deps({
      fetchSeller: () => Promise.resolve(seller([item(1), reused])),
      analyzeImage: vi.fn((url: string) =>
        Promise.resolve({
          ok: true as const,
          hash: url.includes('/main/') ? fastHash : distinctHash(url.length),
          catalogScore: url === listing.photoUrls[0] ? 0.9 : 0.1,
        }),
      ),
    });
    const { checks, verdict } = await analyzeListing(listing, d);

    const photos = checks.find((c) => c.id === 'photos');
    expect(photos).toMatchObject({ status: 'warn', tag: 'Photo type catalogue' });
    expect(photos?.signals.map((s) => s.id)).toEqual(['catalog_photo', 'photo_reused']);
    // Both hints are about the photo: one family, not enough for a review on its own.
    expect(verdict.level).toBe('clean');
  });

  it('confirms the stock pattern with the photos it already analysed', async () => {
    const stock = [
      item(1, {
        title: 'Robe fleurie été Taille S',
        size: 'S',
        photoUrl: 'https://images1.vinted.net/t/s1/f800/a.webp',
      }),
      item(2, {
        title: 'Robe fleurie été taille M',
        size: 'M',
        photoUrl: 'https://images1.vinted.net/t/s2/f800/a.webp',
      }),
    ];
    const d = deps({
      fetchSeller: () => Promise.resolve(seller(stock)),
      analyzeImage: vi.fn((url: string) =>
        Promise.resolve({
          ok: true as const,
          // The two copies share one picture; the listing's own photo is different.
          hash: url.includes('/t/s') ? '0f0ff0f01234abcd' : distinctHash(url.length),
          catalogScore: 0.1,
        }),
      ),
    });
    const { checks, verdict } = await analyzeListing(listing, d);

    const sellerCheck = checks.find((c) => c.id === 'seller');
    expect(sellerCheck?.signals.map((s) => s.id)).toContain('stock_multiple_sizes');
    expect(verdict.level).toBe('review');
  });

  describe('degradation', () => {
    it('turns the seller check off when the seller request fails, and keeps the rest', async () => {
      const d = deps({
        fetchSeller: () => Promise.reject(Object.assign(new Error('x'), { code: 'network' })),
      });
      const { checks, verdict } = await analyzeListing(listing, d);

      expect(checks.map((c) => c.id)).toEqual([
        'image',
        'price',
        'seller',
        'photos',
        'description',
      ]);
      expect(checks[2]).toMatchObject({ status: 'off', tag: 'Indisponible' });
      expect(checks[2]?.detail).toMatch(/Impossible de charger/);
      // The main photo is still analysed, the wardrobe is not.
      expect(vi.mocked(d.analyzeImage)).toHaveBeenCalledTimes(1);
      expect(checks[3]?.status).toBe('ok');
      expect(verdict.level).toBe('clean');
    });

    it('says so when Vinted blocks or throttles the request', async () => {
      const d = deps({
        fetchSeller: () => Promise.reject(Object.assign(new Error('x'), { code: 'blocked' })),
      });
      const { checks } = await analyzeListing(listing, d);
      expect(checks[2]?.detail).toMatch(/limite les requêtes/);
    });

    it('turns the photos check off when the main photo cannot be analysed', async () => {
      const d = deps({
        analyzeImage: vi.fn((url: string) =>
          url === listing.photoUrls[0]
            ? Promise.resolve({ ok: false as const, error: 'HTTP 404' })
            : Promise.resolve({
                ok: true as const,
                hash: distinctHash(url.length),
                catalogScore: 0.1,
              }),
        ),
      });
      const { checks } = await analyzeListing(listing, d);
      expect(checks[3]).toMatchObject({ id: 'photos', status: 'off' });
      expect(checks[2]?.status).toBe('ok');
    });

    it('survives an analyzeImage that throws', async () => {
      const d = deps({ analyzeImage: () => Promise.reject(new Error('context invalidated')) });
      const { checks } = await analyzeListing(listing, d);
      expect(checks[3]).toMatchObject({ id: 'photos', status: 'off' });
    });

    it('survives a malformed hash', async () => {
      const d = deps({
        analyzeImage: () => Promise.resolve({ ok: true as const, hash: 'zz', catalogScore: 0.1 }),
      });
      const { checks } = await analyzeListing(listing, d);
      expect(checks[3]).toMatchObject({ id: 'photos', status: 'off' });
    });

    it('works for a listing without photos', async () => {
      const d = deps();
      const { checks } = await analyzeListing({ ...listing, photoUrls: [] }, d);
      expect(checks[3]).toMatchObject({ id: 'photos', status: 'off' });
      expect(checks).toHaveLength(5);
    });
  });
});

// What each row says is covered in checks/image.test.ts: here, only which row each gate leads to.
describe('analyzeListing image gate', () => {
  const closedGates = ['no_key', 'quota', 'manual', 'expired'] as const;

  it('is "no key" when the gate is not given', async () => {
    const { checks } = await analyzeListing(listing, deps());
    expect(checks[0]).toEqual(imageCheckOff('no_key'));
  });

  it.each(closedGates)('puts the off row of the "%s" gate first', async (imageGate) => {
    const { checks, verdict } = await analyzeListing(listing, deps(), { imageGate });
    expect(checks[0]).toEqual(imageCheckOff(imageGate));
    expect(verdict.withoutImageSearch).toBe(true);
  });

  it('gives the manual row the button that runs the search', async () => {
    const { checks } = await analyzeListing(listing, deps(), { imageGate: 'manual' });
    expect(checks[0]).toMatchObject({ status: 'off', action: 'run_image_search' });
  });

  it('shows the search as running when the gate is ready, without searching by itself', async () => {
    const d = deps();
    const { checks, verdict } = await analyzeListing(listing, d, { imageGate: 'ready' });
    expect(checks[0]).toEqual(imageCheckSearching());
    expect(checks[0]).toMatchObject({ status: 'off', detail: 'Recherche en cours…' });
    expect(checks[0]).not.toHaveProperty('action');
    // The card is shown from the free checks: the search is the caller's business.
    expect(Object.keys(d).sort()).toEqual(['analyzeImage', 'fetchSeller']);
    expect(verdict.withoutImageSearch).toBe(true);
  });

  it('runs the free checks the same way whatever the gate', async () => {
    const results = await Promise.all(
      (['ready', 'no_key', 'quota', 'manual', 'expired'] as const).map((imageGate) =>
        analyzeListing(listing, deps(), { imageGate }),
      ),
    );
    for (const { checks } of results) expect(checks.slice(1)).toEqual(results[0]?.checks.slice(1));
  });
});

describe('searchPhoto', () => {
  const searching = (searchImage: SearchDeps['searchImage']): SearchDeps => ({ searchImage });

  it('passes the answer of the background through', async () => {
    const d = searching(() => Promise.resolve(found(exactMatch)));
    expect(await searchPhoto('https://images1.vinted.net/a.webp', d)).toEqual(found(exactMatch));
  });

  it('asks for the search, for the cache alone, or for another attempt', async () => {
    const searchImage = vi.fn(() => Promise.resolve<SearchImageResponse>({ status: 'not_cached' }));
    await searchPhoto('https://images1.vinted.net/a.webp', searching(searchImage));
    expect(searchImage).toHaveBeenLastCalledWith('https://images1.vinted.net/a.webp', false, false);
    await searchPhoto('https://images1.vinted.net/a.webp', searching(searchImage), true);
    expect(searchImage).toHaveBeenLastCalledWith('https://images1.vinted.net/a.webp', true, false);
    await searchPhoto('https://images1.vinted.net/a.webp', searching(searchImage), false, true);
    expect(searchImage).toHaveBeenLastCalledWith('https://images1.vinted.net/a.webp', false, true);
  });

  it('turns a missing photo and a rejection into failures, never into an exception', async () => {
    const searchImage = vi.fn(() => Promise.reject(new Error('gone')));
    expect(await searchPhoto(undefined, searching(searchImage))).toEqual({
      status: 'error',
      reason: 'photo',
    });
    expect(searchImage).not.toHaveBeenCalled();
    expect(await searchPhoto('https://images1.vinted.net/a.webp', searching(searchImage))).toEqual({
      status: 'error',
      reason: 'network',
    });
  });

  it('reads no answer at all (a background that did not reply) as a failed search', async () => {
    const nothing = searching(() => Promise.resolve(undefined as unknown as SearchImageResponse));
    expect(await searchPhoto('https://images1.vinted.net/a.webp', nothing)).toEqual({
      status: 'error',
      reason: 'network',
    });
  });
});

describe('the price row', () => {
  const priceOf = (result: { checks: CheckResult[] }) =>
    result.checks.find((c) => c.id === 'price');
  const analysed = () => analyzeListing(listing, deps(), { imageGate: 'manual' });

  it('starts as "not compared" with nothing to compare to', async () => {
    expect(priceOf(await analysed())).toEqual({
      id: 'price',
      status: 'off',
      tag: 'Non comparé',
      detail: "Pas de prix d'origine à comparer.",
      signals: [],
    });
  });

  it('sends the buyer to the image links once the search found the photo, whichever step ran last', async () => {
    const before = await analysed();
    const detail =
      'Shein et Temu cachent leurs prix aux robots : compare toi-même avec les liens ci-dessus.';
    const searched = withImageSearch(before, found(exactMatch));
    expect(priceOf(searched)).toMatchObject({ status: 'off', tag: 'Non comparé', detail });
    expect(searched.rawChecks.find((c) => c.id === 'price')).toEqual(priceOf(searched));
    // A review on top of it, or a lookalike only, changes nothing of that.
    expect(priceOf(withAiReview(searched, { status: 'no_key' }))).toMatchObject({ detail });
    expect(priceOf(withImageSearch(before, found(similarMatch)))).toMatchObject({ detail });
  });

  it('goes back to "nothing to compare" when a new search finds nothing or fails', async () => {
    const searched = withImageSearch(await analysed(), found(exactMatch));
    const nothing = withImageSearch(searched, found());
    expect(priceOf(nothing)?.detail).toBe("Pas de prix d'origine à comparer.");
    const failed = withImageSearch(searched, { status: 'error', reason: 'network' });
    expect(priceOf(failed)?.detail).toBe("Pas de prix d'origine à comparer.");
  });

  it('never gives a signal, so it cannot move the verdict', async () => {
    const searched = withImageSearch(await analysed(), found(exactMatch));
    expect(priceOf(searched)?.signals).toEqual([]);
  });
});

describe('askAiReview', () => {
  const okReview: AiReviewResponse = {
    status: 'ok',
    review: { catalogPhoto: false, summary: 'Ok.' },
  };
  const analysed = () => analyzeListing(listing, deps(), { imageGate: 'manual' });

  it('sends the listing and the signals of the result, and passes the answer through', async () => {
    const aiReview = vi.fn<AiDeps['aiReview']>(() => Promise.resolve(okReview));
    const result = withImageSearch(await analysed(), found(exactMatch));
    expect(await askAiReview(listing, result, { aiReview })).toEqual(okReview);

    expect(aiReview).toHaveBeenCalledOnce();
    const [input, cacheOnly] = aiReview.mock.calls[0] ?? [];
    expect(cacheOnly).toBe(false);
    expect(input).toMatchObject({
      photoUrl: listing.photoUrls[0],
      title: 'Robe fleurie',
      description: listing.description,
    });
    expect(input?.signals[0]).toBe("Recherche d'image : la même photo est en vente sur Shein.");
    // The fingerprint starts with the same image line, then the tags of the rows that ran.
    expect(input?.fingerprint[0]).toBe(input?.signals[0]);
    expect(input?.fingerprint.slice(1)).toEqual([
      expect.stringMatching(/^seller:/),
      expect.stringMatching(/^photos:/),
      expect.stringMatching(/^description:/),
    ]);
  });

  it('builds the signals from the raw rows, so a review never feeds on its own conclusion', async () => {
    const aiReview = vi.fn<AiDeps['aiReview']>(() => Promise.resolve(okReview));
    const before = await analysed();
    const reviewed = withAiReview(before, {
      status: 'ok',
      review: { catalogPhoto: true, summary: 'Photo de studio.' },
    });
    await askAiReview(listing, before, { aiReview });
    await askAiReview(listing, reviewed, { aiReview });
    expect(aiReview.mock.calls[1]?.[0]).toEqual(aiReview.mock.calls[0]?.[0]);
    expect(JSON.stringify(aiReview.mock.calls[1]?.[0])).not.toContain("L'IA confirme");
  });

  it('asks for the cache alone when told to', async () => {
    const aiReview = vi.fn<AiDeps['aiReview']>(() => Promise.resolve({ status: 'not_cached' }));
    expect(await askAiReview(listing, await analysed(), { aiReview }, true)).toEqual({
      status: 'not_cached',
    });
    expect(aiReview.mock.calls[0]?.[1]).toBe(true);
    await askAiReview(listing, await analysed(), { aiReview }, false, true);
    expect(aiReview.mock.calls[1]?.slice(1)).toEqual([false, true]);
  });

  it('turns a missing photo, a rejection and no answer at all into failures, never into an exception', async () => {
    const result = await analysed();
    const aiReview = vi.fn<AiDeps['aiReview']>(() => Promise.resolve(okReview));
    expect(await askAiReview({ ...listing, photoUrls: [] }, result, { aiReview })).toEqual({
      status: 'error',
      reason: 'photo',
    });
    expect(aiReview).not.toHaveBeenCalled();

    const rejecting = {
      aiReview: () => Promise.reject(new Error('Extension context invalidated')),
    };
    expect(await askAiReview(listing, result, rejecting)).toEqual({
      status: 'error',
      reason: 'network',
    });
    const silent = { aiReview: () => Promise.resolve(undefined as never) };
    expect(await askAiReview(listing, result, silent)).toEqual({
      status: 'error',
      reason: 'network',
    });
  });
});

describe('withImageSearch', () => {
  const copies = Array.from({ length: 12 }, (_, i) => item(i + 1, { condition: 'new_with_tags' }));
  const withCopies = () => deps({ fetchSeller: () => Promise.resolve(seller(copies)) });
  const analysed = (imageGate: 'ready' | 'manual', d = withCopies()) =>
    analyzeListing(listing, d, { imageGate });

  it('replaces the image row (and the price row that follows it) and redoes the verdict, nothing else', async () => {
    const before = await analysed('manual');
    expect(before.verdict.level).toBe('review');
    expect(before.checks[0]).toMatchObject({ action: 'run_image_search' });

    const after = withImageSearch(before, found(exactMatch));
    expect(after.checks[0]).toMatchObject({ status: 'bad', tag: 'Trouvée sur Shein' });
    expect(after.verdict.level).toBe('dropshipping');
    expect(after.checks.map((c) => c.id)).toEqual([
      'image',
      'price',
      'seller',
      'photos',
      'description',
    ]);
    // The price row follows the image matches (see the price row tests).
    expect(after.checks[1]).toMatchObject({ id: 'price', tag: 'Non comparé' });
    expect(after.checks[1]?.detail).not.toBe(before.checks[1]?.detail);
    expect(after.checks[4]).toEqual(before.checks[4]);
  });

  it('replaces the "searching" row of the ready gate the same way', async () => {
    const before = await analysed('ready');
    expect(before.checks[0]).toEqual(imageCheckSearching());
    const after = withImageSearch(before, found(exactMatch));
    expect(after.checks[0]).toMatchObject({ status: 'bad', tag: 'Trouvée sur Shein' });
    expect(after.verdict.withoutImageSearch).toBe(false);
  });

  it('calls an exact match red and the verdict an honest resale without other signals', async () => {
    const before = await analyzeListing(listing, deps(), { imageGate: 'ready' });
    const after = withImageSearch(before, found(exactMatch, similarMatch));
    expect(after.checks[0]).toMatchObject({ status: 'bad', tag: 'Trouvée sur Shein' });
    expect(after.checks[0]?.matches).toEqual([exactMatch, similarMatch]);
    expect(after.verdict).toMatchObject({ level: 'resold', title: 'Article Shein revendu' });
    expect(after.verdict.withoutImageSearch).toBe(false);
  });

  it('gives the local rows back their red once an exact match backs them', async () => {
    const before = await analysed('manual');
    expect(before.checks.find((c) => c.id === 'seller')?.status).toBe('warn');
    const after = withImageSearch(before, found(exactMatch));
    expect(after.checks.find((c) => c.id === 'seller')?.status).toBe('bad');
  });

  it('calls a similar photo orange, keeps the cap on the local rows and the verdict "to verify"', async () => {
    const after = withImageSearch(await analysed('manual'), found(similarMatch));
    expect(after.checks[0]).toMatchObject({ status: 'warn', tag: 'Photo proche' });
    expect(after.checks.find((c) => c.id === 'seller')?.status).toBe('warn');
    expect(after.verdict).toMatchObject({ level: 'review', title: 'À vérifier' });
    expect(after.verdict.lines).toContain('Photo ressemblante sur Temu');
  });

  it('turns a clean listing green when nothing is found', async () => {
    const before = await analyzeListing(listing, deps(), { imageGate: 'manual' });
    expect(before.verdict.withoutImageSearch).toBe(true);
    const after = withImageSearch(before, found());
    expect(after.checks[0]).toMatchObject({ status: 'ok', tag: 'Introuvable' });
    expect(after.verdict).toMatchObject({
      level: 'clean',
      title: 'Rien de suspect',
      withoutImageSearch: false,
    });
  });

  it.each([
    [{ status: 'no_key' }, 'Désactivée'],
    [{ status: 'quota' }, 'Plafond atteint'],
  ] as const)('shows the off row when the background says %j', async (response, tag) => {
    const after = withImageSearch(await analysed('ready'), response);
    expect(after.checks[0]).toMatchObject({ status: 'off', tag });
    expect(after.verdict.withoutImageSearch).toBe(true);
  });

  it('shows the failure on the row, and can be run again from the same result', async () => {
    const before = await analysed('manual');
    const failed = withImageSearch(before, { status: 'error', reason: 'billing' });
    expect(failed.checks[0]).toMatchObject({
      status: 'off',
      tag: 'Recherche impossible',
      action: 'open_keys',
    });
    expect(failed.verdict.withoutImageSearch).toBe(true);
    // Another attempt starts from the same raw rows.
    expect(withImageSearch(failed, found(exactMatch)).verdict.level).toBe('dropshipping');
  });

  it('does not change the result it is given', async () => {
    const before = await analysed('manual');
    const snapshot = structuredClone(before);
    withImageSearch(before, found(exactMatch));
    expect(before).toEqual(snapshot);
  });
});

describe('withAiReview', () => {
  const review = (catalogPhoto: boolean): AiReviewResponse => ({
    status: 'ok',
    review: { catalogPhoto, summary: 'Un résumé.' },
  });
  const analysed = (imageGate: 'ready' | 'manual' = 'manual') =>
    analyzeListing(listing, deps(), { imageGate });
  const photosOf = (result: { checks: CheckResult[] }) =>
    result.checks.find((c) => c.id === 'photos');

  it('starts without a review', async () => {
    expect((await analysed()).aiReview).toBeNull();
  });

  it('makes the photos row only a weak catalogue hint when nothing else backs the AI, whatever the local score', async () => {
    const before = await analysed();
    expect(photosOf(before)).toMatchObject({ status: 'ok', tag: 'Rien de notable' });

    const after = withAiReview(before, review(true));
    expect(photosOf(after)).toEqual({
      id: 'photos',
      status: 'warn',
      tag: 'Photo type catalogue',
      detail: "L'IA voit une photo de catalogue ou de studio.",
      signals: [{ id: 'catalog_photo', strength: 'weak' }],
    });
    expect(after.aiReview).toEqual({ catalogPhoto: true, summary: 'Un résumé.' });
  });

  it('never moves a green verdict to orange through the AI alone', async () => {
    const before = await analysed();
    expect(before.verdict.level).toBe('clean');
    // Nothing found by the image search, a lookalike only, a search not run: the hint stays weak.
    for (const base of [
      before,
      withImageSearch(before, found()),
      withImageSearch(before, found(similarMatch)),
    ]) {
      const after = withAiReview(base, review(true));
      expect(photosOf(after)?.signals).toEqual([{ id: 'catalog_photo', strength: 'weak' }]);
      expect(after.verdict.level).toBe(base.verdict.level);
    }
    expect(withAiReview(withImageSearch(before, found()), review(true)).verdict.level).toBe(
      'clean',
    );
  });

  it('is strong, and red, only when an exact image match backs it', async () => {
    const reviewed = withAiReview(await analysed(), review(true));
    expect(photosOf(reviewed)?.status).toBe('warn');
    const backed = withImageSearch(reviewed, found(exactMatch));
    expect(photosOf(backed)).toEqual({
      id: 'photos',
      status: 'bad',
      tag: 'Photo catalogue',
      detail: "L'IA confirme une photo de catalogue ou de studio.",
      signals: [{ id: 'catalog_photo', strength: 'strong' }],
    });
    // An exact match and a strong signal is what the design calls dropshipping.
    expect(backed.verdict.level).toBe('dropshipping');
    // The match is gone (a new search found nothing): the hint is weak again.
    expect(photosOf(withImageSearch(backed, found()))?.signals).toEqual([
      { id: 'catalog_photo', strength: 'weak' },
    ]);
  });

  it('composes in either order: image then AI, or AI then image', async () => {
    const before = await analysed();
    const imageThenAi = withAiReview(withImageSearch(before, found(exactMatch)), review(true));
    const aiThenImage = withImageSearch(withAiReview(before, review(true)), found(exactMatch));
    expect(aiThenImage).toEqual(imageThenAi);
    expect(imageThenAi.verdict.level).toBe('dropshipping');
    expect(photosOf(imageThenAi)).toMatchObject({ status: 'bad', tag: 'Photo catalogue' });
    const noMatch = [found(), found(similarMatch)];
    for (const response of noMatch) {
      expect(withAiReview(withImageSearch(before, response), review(true))).toEqual(
        withImageSearch(withAiReview(before, review(true)), response),
      );
    }
  });

  it('leaves the local row and the verdict as they are when the AI says the photo is not a catalogue shot', async () => {
    const before = await analysed();
    const after = withAiReview(before, review(false));
    expect(after.checks).toEqual(before.checks);
    expect(after.verdict).toEqual(before.verdict);
    // The review is kept for the card's summary.
    expect(after.aiReview).toEqual({ catalogPhoto: false, summary: 'Un résumé.' });
  });

  it('does not downgrade a local catalogue hint when the AI says no', async () => {
    const reused = item(2, { photoUrl: 'https://images1.vinted.net/t/main/f800/copy.webp?s=2' });
    const d = deps({
      fetchSeller: () => Promise.resolve(seller([item(1), reused])),
      analyzeImage: vi.fn((url: string) =>
        Promise.resolve({
          ok: true as const,
          hash: url.includes('/main/') ? fastHash : distinctHash(url.length),
          catalogScore: url === listing.photoUrls[0] ? 0.9 : 0.1,
        }),
      ),
    });
    const before = await analyzeListing(listing, d, { imageGate: 'manual' });
    const after = withAiReview(before, review(false));
    expect(photosOf(after)).toEqual(photosOf(before));
    expect(photosOf(after)?.signals.map((s) => [s.id, s.strength])).toEqual([
      ['catalog_photo', 'weak'],
      ['photo_reused', 'weak'],
    ]);
  });

  it('keeps what the row says about a reused photo next to the AI sentence', async () => {
    const reused = item(2, { photoUrl: 'https://images1.vinted.net/t/main/f800/copy.webp?s=2' });
    const d = deps({ fetchSeller: () => Promise.resolve(seller([item(1), reused])) });
    const after = withAiReview(await analyzeListing(listing, d), review(true));
    expect(photosOf(after)?.detail).toBe(
      "L'IA voit une photo de catalogue ou de studio. La même photo sert sur 1 autre annonce du vendeur.",
    );
    expect(photosOf(after)?.signals.map((s) => s.id)).toEqual(['catalog_photo', 'photo_reused']);
  });

  it('takes the photo into account even when the local analysis could not read it, and says so', async () => {
    const d = deps({
      analyzeImage: vi.fn(() => Promise.resolve({ ok: false as const, error: 'x' })),
    });
    const before = await analyzeListing(listing, d);
    expect(photosOf(before)).toMatchObject({ status: 'off', tag: 'Non analysée' });
    const unread = "L'IA voit une photo de catalogue (analyse locale impossible).";
    expect(photosOf(withAiReview(before, review(true)))).toMatchObject({
      status: 'warn',
      tag: 'Photo type catalogue',
      detail: unread,
      signals: [{ id: 'catalog_photo', strength: 'weak' }],
    });
    expect(
      photosOf(withAiReview(withImageSearch(before, found(exactMatch)), review(true))),
    ).toMatchObject({
      status: 'bad',
      tag: 'Photo catalogue',
      detail: "L'IA confirme une photo de catalogue ou de studio (analyse locale impossible).",
      signals: [{ id: 'catalog_photo', strength: 'strong' }],
    });
  });

  it.each([
    { status: 'no_key' },
    { status: 'quota' },
    { status: 'not_cached' },
    { status: 'error', reason: 'network' },
    { status: 'error', reason: 'invalid_answer' },
  ] as const)('leaves the result alone when the background says %j', async (response) => {
    const before = await analysed();
    expect(withAiReview(before, response)).toBe(before);
  });

  it('keeps the review through a later image search, and the raw rows free of it', async () => {
    const reviewed = withAiReview(await analysed(), review(true));
    expect(reviewed.rawChecks.find((c) => c.id === 'photos')?.tag).toBe('Rien de notable');
    const searched = withImageSearch(reviewed, found());
    expect(searched.aiReview).toEqual(reviewed.aiReview);
    expect(photosOf(searched)).toMatchObject({ tag: 'Photo type catalogue' });
  });

  it('can be run again from the same result, the last review winning', async () => {
    const first = withAiReview(await analysed(), review(true));
    const second = withAiReview(first, review(false));
    expect(photosOf(second)).toMatchObject({ tag: 'Rien de notable' });
    expect(second.aiReview?.catalogPhoto).toBe(false);
  });

  it('does not change the result it is given', async () => {
    const before = await analysed();
    const snapshot = structuredClone(before);
    withAiReview(before, review(true));
    expect(before).toEqual(snapshot);
  });
});

describe('analyzeListing cancellation', () => {
  it('makes no request at all when already cancelled', async () => {
    const d = deps();
    await expect(analyzeListing(listing, d, { isCancelled: () => true })).rejects.toBeInstanceOf(
      AnalysisCancelledError,
    );
    expect(d.fetchSeller).not.toHaveBeenCalled();
    expect(d.analyzeImage).not.toHaveBeenCalled();
  });

  it('analyses no photo when cancelled during the seller fetch', async () => {
    let cancelled = false;
    const d = deps({
      fetchSeller: () => {
        cancelled = true;
        return Promise.resolve(seller([item(1), item(2)]));
      },
    });
    await expect(
      analyzeListing(listing, d, { isCancelled: () => cancelled }),
    ).rejects.toBeInstanceOf(AnalysisCancelledError);
    expect(d.analyzeImage).not.toHaveBeenCalled();
  });

  it('stops downloading photos once cancelled', async () => {
    const items = Array.from({ length: 30 }, (_, i) => item(i + 1));
    const d = deps({ fetchSeller: () => Promise.resolve(seller(items)) });
    const analyze = vi.mocked(d.analyzeImage);
    const isCancelled = () => analyze.mock.calls.length >= 3;

    await expect(analyzeListing(listing, d, { isCancelled })).rejects.toBeInstanceOf(
      AnalysisCancelledError,
    );
    // Photos already in flight finish; none starts after the cancellation.
    expect(analyze.mock.calls.length).toBeLessThanOrEqual(3 + IMAGE_CONCURRENCY);
    expect(analyze.mock.calls.length).toBeLessThan(1 + MAX_OTHER_PHOTOS);
  });
});

describe('capLocalHeuristics', () => {
  const row = (id: CheckResult['id'], status: CheckResult['status']): CheckResult => ({
    id,
    status,
    tag: '',
    detail: '',
    signals: [{ id: 'stock_multiple_sizes', strength: 'strong' }],
  });
  const all: CheckResult[] = [
    row('image', 'bad'),
    row('price', 'bad'),
    row('seller', 'bad'),
    row('photos', 'bad'),
    row('description', 'bad'),
  ];
  const exact: ImageMatch = { platform: 'Shein', url: 'https://x', exact: true, price: null };
  const similar: ImageMatch = { ...exact, exact: false };

  it('caps the local heuristic rows at warn without an exact match, signals untouched', () => {
    const capped = capLocalHeuristics(all, [similar]);
    expect(capped.map((c) => c.status)).toEqual(['bad', 'bad', 'warn', 'warn', 'warn']);
    expect(capped[2]?.signals).toEqual(all[2]?.signals);
  });

  it('leaves every row alone when an exact match backs the verdict', () => {
    expect(capLocalHeuristics(all, [exact])).toEqual(all);
  });

  it('does not touch rows that are not bad', () => {
    const mixed = [row('seller', 'ok'), row('photos', 'off'), row('description', 'warn')];
    expect(capLocalHeuristics(mixed, [])).toEqual(mixed);
  });

  it('caps a seller row that earned a strong signal in the full analysis', async () => {
    const copies = Array.from({ length: 12 }, (_, i) =>
      item(i + 1, { condition: 'new_with_tags' }),
    );
    const d = deps({ fetchSeller: () => Promise.resolve(seller(copies)) });
    const { checks, verdict } = await analyzeListing(listing, d);
    const sellerCheck = checks.find((c) => c.id === 'seller');
    expect(sellerCheck?.signals.map((s) => s.id)).toContain('mostly_new_with_tags');
    expect(sellerCheck?.status).toBe('warn');
    expect(verdict.level).toBe('review');
  });
});
