import { describe, expect, it, vi } from 'vitest';
import {
  AnalysisCancelledError,
  capLocalHeuristics,
  IMAGE_CONCURRENCY,
  MAX_OTHER_PHOTOS,
  analyzeListing,
  searchPhoto,
  withImageSearch,
  type AnalysisDeps,
  type SearchDeps,
} from './analysis';
import { imageCheckOff, imageCheckSearching } from './checks/image';
import { hashToHex } from './image/pixels';
import type { SearchImageResponse } from './messages';
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
  const closedGates = ['no_key', 'quota', 'manual'] as const;

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
      (['ready', 'no_key', 'quota', 'manual'] as const).map((imageGate) =>
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

  it('asks for the search, or for the cache alone', async () => {
    const searchImage = vi.fn(() => Promise.resolve<SearchImageResponse>({ status: 'not_cached' }));
    await searchPhoto('https://images1.vinted.net/a.webp', searching(searchImage));
    expect(searchImage).toHaveBeenLastCalledWith('https://images1.vinted.net/a.webp', false);
    await searchPhoto('https://images1.vinted.net/a.webp', searching(searchImage), true);
    expect(searchImage).toHaveBeenLastCalledWith('https://images1.vinted.net/a.webp', true);
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

describe('withImageSearch', () => {
  const copies = Array.from({ length: 12 }, (_, i) => item(i + 1, { condition: 'new_with_tags' }));
  const withCopies = () => deps({ fetchSeller: () => Promise.resolve(seller(copies)) });
  const analysed = (imageGate: 'ready' | 'manual', d = withCopies()) =>
    analyzeListing(listing, d, { imageGate });

  it('replaces the image row and redoes the verdict, nothing else', async () => {
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
    expect(after.checks[1]).toEqual(before.checks[1]);
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
