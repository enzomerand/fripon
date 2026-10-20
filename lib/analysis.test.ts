import { describe, expect, it, vi } from 'vitest';
import { IMAGE_CONCURRENCY, MAX_OTHER_PHOTOS, analyzeListing, type AnalysisDeps } from './analysis';
import { hashToHex } from './image/pixels';
import type { Listing, Seller, SellerItem } from './model';

const NOW = new Date('2026-10-20T12:00:00Z');

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
  price: { amount: 10, currency: 'EUR' },
  photoUrl: `https://images1.vinted.net/t/${n}/f800/p.webp?s=${n}`,
  ...overrides,
});

const seller = (items: SellerItem[]): Seller => ({
  id: '7000001',
  login: 'vendeuse_test',
  createdAt: null,
  feedbackCount: 80,
  rating: 4.8,
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
    now: () => NOW,
    ...overrides,
  };
}

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

  it('flags a catalogue main photo and a photo reused by the seller', async () => {
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
    expect(photos).toMatchObject({ status: 'bad', tag: 'Photo catalogue' });
    expect(photos?.signals.map((s) => s.id)).toEqual(['catalog_photo', 'photo_reused']);
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
