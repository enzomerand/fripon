import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ImageMatch } from '../model';
import {
  VISION_CACHE_MAX_ENTRIES,
  VISION_CACHE_PREFIX,
  VISION_CACHE_TTL_MS,
  readVisionCache,
  visionCacheKey,
  writeVisionCache,
} from './search-cache';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const PHOTO = 'https://images1.vinted.net/t/01_abc/f800/123.webp?s=aa';
const MATCHES: ImageMatch[] = [
  { platform: 'Shein', url: 'https://fr.shein.com/Robe-p-1.html', exact: true, price: null },
  { platform: 'Temu', url: 'https://www.temu.com/robe-g-2.html', exact: false, price: null },
];

const keyOf = (n: number) => `${VISION_CACHE_PREFIX}https://images1.vinted.net/t/${n}/f800/p.webp`;
const stored = async () => Object.keys(await browser.storage.local.get(null));

beforeEach(() => {
  fakeBrowser.reset();
});

describe('visionCacheKey', () => {
  it('is the origin and the path of the photo, without the query string', () => {
    expect(visionCacheKey(PHOTO)).toBe(
      'fripon:vision:v1:https://images1.vinted.net/t/01_abc/f800/123.webp',
    );
  });

  it('is the same for the same picture with another signature', () => {
    expect(visionCacheKey(`${PHOTO}&x=1`)).toBe(
      visionCacheKey('https://images1.vinted.net/t/01_abc/f800/123.webp'),
    );
  });

  it('tells two pictures apart', () => {
    expect(visionCacheKey('https://images1.vinted.net/t/02/f800/a.webp')).not.toBe(
      visionCacheKey('https://images1.vinted.net/t/03/f800/a.webp'),
    );
  });
});

describe('readVisionCache / writeVisionCache', () => {
  it('gives back what was written, and stores nothing else than the matches and the date', async () => {
    const key = visionCacheKey(PHOTO);
    expect(await readVisionCache(key, NOW)).toBeNull();

    await writeVisionCache(key, MATCHES, NOW);
    expect(await readVisionCache(key, NOW + 1000)).toEqual(MATCHES);
    expect((await browser.storage.local.get(key))[key]).toEqual({ matches: MATCHES, at: NOW });
  });

  it('keeps an empty result: "nothing found" is worth remembering too', async () => {
    const key = visionCacheKey(PHOTO);
    await writeVisionCache(key, [], NOW);
    expect(await readVisionCache(key, NOW)).toEqual([]);
  });

  it('forgets a result after 7 days', async () => {
    const key = visionCacheKey(PHOTO);
    await writeVisionCache(key, MATCHES, NOW);
    expect(VISION_CACHE_TTL_MS).toBe(7 * 24 * 3600 * 1000);
    expect(await readVisionCache(key, NOW + VISION_CACHE_TTL_MS)).toEqual(MATCHES);
    expect(await readVisionCache(key, NOW + VISION_CACHE_TTL_MS + 1)).toBeNull();
  });

  it.each([
    ['not an object', 'x'],
    ['no matches', { at: NOW }],
    ['matches that are not a list', { matches: 'x', at: NOW }],
    ['no date', { matches: [] }],
    ['a date that is not a number', { matches: [], at: 'now' }],
    ['a date that is not finite', { matches: [], at: null }],
    ['a match that is not an object', { matches: [null], at: NOW }],
    [
      'a match without a platform',
      { matches: [{ url: 'https://a.test/', exact: true, price: null }], at: NOW },
    ],
    [
      'a match with a javascript link',
      {
        matches: [{ platform: 'Shein', url: 'javascript:alert(1)', exact: true, price: null }],
        at: NOW,
      },
    ],
    [
      'a match with a bad price',
      {
        matches: [
          { platform: 'Shein', url: 'https://a.test/', exact: true, price: { amount: 'x' } },
        ],
        at: NOW,
      },
    ],
    [
      'a match with no exact flag',
      { matches: [{ platform: 'Shein', url: 'https://a.test/', price: null }], at: NOW },
    ],
  ])('treats an entry with %s as a miss', async (_name, value) => {
    const key = visionCacheKey(PHOTO);
    await browser.storage.local.set({ [key]: value });
    expect(await readVisionCache(key, NOW)).toBeNull();
  });

  it('treats an entry that holds a price as a miss: this version never wrote one', async () => {
    const key = visionCacheKey(PHOTO);
    const priced = { ...MATCHES[0], price: { amount: 9.5, currency: 'EUR' } };
    await browser.storage.local.set({ [key]: { matches: [priced], at: NOW } });
    expect(await readVisionCache(key, NOW)).toBeNull();
  });
});

describe('cache pruning', () => {
  it('keeps at most 200 entries, dropping the oldest', async () => {
    expect(VISION_CACHE_MAX_ENTRIES).toBe(200);
    for (let n = 0; n < VISION_CACHE_MAX_ENTRIES + 5; n++) {
      await writeVisionCache(keyOf(n), MATCHES, NOW + n);
    }
    const keys = (await stored()).filter((k) => k.startsWith(VISION_CACHE_PREFIX));
    expect(keys).toHaveLength(VISION_CACHE_MAX_ENTRIES);
    for (let n = 0; n < 5; n++) expect(keys).not.toContain(keyOf(n));
    expect(keys).toContain(keyOf(5));
    expect(keys).toContain(keyOf(VISION_CACHE_MAX_ENTRIES + 4));
  });

  it('removes expired and damaged entries when it writes', async () => {
    await browser.storage.local.set({
      [keyOf(1)]: { matches: [], at: NOW - VISION_CACHE_TTL_MS - 1 },
      [keyOf(2)]: 'garbage',
      [keyOf(3)]: { matches: [], at: NOW - 1000 },
    });
    await writeVisionCache(keyOf(4), MATCHES, NOW);
    const keys = (await stored()).sort();
    expect(keys).toEqual([keyOf(3), keyOf(4)].sort());
  });

  it('keeps the entry it just wrote even when others have the same date', async () => {
    const seeded: Record<string, unknown> = {};
    for (let n = 0; n < VISION_CACHE_MAX_ENTRIES; n++) seeded[keyOf(n)] = { matches: [], at: NOW };
    await browser.storage.local.set(seeded);
    await writeVisionCache(keyOf(999), MATCHES, NOW);
    const keys = await stored();
    expect(keys).toHaveLength(VISION_CACHE_MAX_ENTRIES);
    expect(keys).toContain(keyOf(999));
  });

  it('never touches what is not a Vision entry', async () => {
    await browser.storage.local.set({
      'fripon:settings:v1': { mode: 'auto' },
      'fripon:credits:v1:vision:2026-10': 3,
      'fripon:seller:v2:42': { at: 1 },
    });
    for (let n = 0; n < VISION_CACHE_MAX_ENTRIES + 3; n++) {
      await writeVisionCache(keyOf(n), [], NOW + n);
    }
    const keys = await stored();
    expect(keys).toContain('fripon:settings:v1');
    expect(keys).toContain('fripon:credits:v1:vision:2026-10');
    expect(keys).toContain('fripon:seller:v2:42');
  });
});
