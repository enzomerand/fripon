import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getUsage, reserve } from '../credits';
import type { WebDetectResult } from '../google/vision';
import { saveSettings } from '../settings';
import { bytesToBase64, createImageSearcher } from './search';
import { VISION_CACHE_PREFIX, VISION_CACHE_TTL_MS } from './search-cache';

const KEY = 'AIzaSyFakeKeyForTestsOnly_0123456789abcd';
const PHOTO = 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa';
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const BYTES = new Uint8Array([1, 2, 3]);

const FOUND: WebDetectResult = {
  ok: true,
  webDetection: {
    pagesWithMatchingImages: [
      { url: 'https://fr.shein.com/style/Robes-sc-1.html', partialMatchingImages: [{ url: 'u' }] },
      {
        url: 'https://fr.shein.com/Robe-Test-p-1234567-cat-1727.html',
        fullMatchingImages: [{ url: 'u' }],
      },
      { url: 'https://www.pinterest.com/pin/1/', fullMatchingImages: [{ url: 'u' }] },
    ],
  },
};

let clock = NOW;

function setup(
  webDetectResult: WebDetectResult | Error = FOUND,
  fetchPhoto: () => Promise<Blob> = () => Promise.resolve(new Blob([BYTES])),
) {
  const photo = vi.fn(fetchPhoto);
  const detect = vi.fn<(base64: string, key: string) => Promise<WebDetectResult>>(() =>
    webDetectResult instanceof Error
      ? Promise.reject(webDetectResult)
      : Promise.resolve(webDetectResult),
  );
  const search = createImageSearcher({
    fetchPhoto: photo,
    webDetect: detect,
    now: () => clock,
  });
  return { search, photo, detect };
}

const used = async () => (await getUsage('vision', null)).used;
const cacheKeys = async () =>
  Object.keys(await browser.storage.local.get(null)).filter((k) =>
    k.startsWith(VISION_CACHE_PREFIX),
  );

beforeEach(async () => {
  fakeBrowser.reset();
  clock = NOW;
  await saveSettings({ keys: { vision: KEY } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bytesToBase64', () => {
  it('encodes small and large inputs like the standard base64', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
    expect(bytesToBase64(new Uint8Array([1, 2, 3]))).toBe('AQID');
    const big = Uint8Array.from({ length: 100_003 }, (_, i) => (i * 31) % 256);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});

describe('createImageSearcher search', () => {
  it('sends the photo to Vision with the saved key and returns the matches, exact first', async () => {
    const { search, photo, detect } = setup();
    const result = await search(PHOTO);

    expect(photo).toHaveBeenCalledWith(PHOTO);
    expect(detect).toHaveBeenCalledOnce();
    expect(detect).toHaveBeenCalledWith('AQID', KEY);
    expect(result).toEqual({
      status: 'ok',
      matches: [
        {
          platform: 'Shein',
          url: 'https://fr.shein.com/Robe-Test-p-1234567-cat-1727.html',
          exact: true,
          price: null,
        },
        {
          platform: 'Shein',
          url: 'https://fr.shein.com/style/Robes-sc-1.html',
          exact: false,
          price: null,
        },
      ],
    });
  });

  it('spends exactly one Vision credit', async () => {
    const { search } = setup();
    await search(PHOTO);
    expect(await used()).toBe(1);
  });

  it('answers "nothing found" with an empty list, and still spends the credit', async () => {
    const { search } = setup({ ok: true, webDetection: {} });
    expect(await search(PHOTO)).toEqual({ status: 'ok', matches: [] });
    expect(await used()).toBe(1);
  });

  it('never puts the key or the raw answer in the response', async () => {
    const { search } = setup();
    const json = JSON.stringify(await search(PHOTO));
    expect(json).not.toContain(KEY);
    expect(json).not.toContain('pinterest');
    expect(json).not.toContain('pagesWithMatchingImages');
  });
});

describe('createImageSearcher cache', () => {
  it('answers a photo searched before without calling anything, for free', async () => {
    const first = setup();
    const result = await first.search(PHOTO);
    expect(await cacheKeys()).toEqual([
      `${VISION_CACHE_PREFIX}https://images1.vinted.net/t/01_a/f800/main.webp`,
    ]);

    // A new searcher (the service worker restarted), the same picture with another signature.
    const again = setup();
    expect(await again.search('https://images1.vinted.net/t/01_a/f800/main.webp?s=zz')).toEqual(
      result,
    );
    expect(again.photo).not.toHaveBeenCalled();
    expect(again.detect).not.toHaveBeenCalled();
    expect(await used()).toBe(1);
  });

  it('reuses a "nothing found" result too', async () => {
    const { search, detect } = setup({ ok: true, webDetection: {} });
    await search(PHOTO);
    expect(await search(PHOTO)).toEqual({ status: 'ok', matches: [] });
    expect(detect).toHaveBeenCalledOnce();
  });

  it('serves the cache even without a key, or with the cap reached', async () => {
    const { search } = setup();
    await search(PHOTO);
    await saveSettings({ keys: { vision: '' } });
    expect((await search(PHOTO)).status).toBe('ok');
    await saveSettings({ keys: { vision: KEY }, caps: { vision: 1 } });
    expect((await search(PHOTO)).status).toBe('ok');
  });

  it('searches again after 7 days', async () => {
    const { search, detect } = setup();
    await search(PHOTO);
    clock = NOW + VISION_CACHE_TTL_MS;
    await search(PHOTO);
    expect(detect).toHaveBeenCalledOnce();
    clock = NOW + VISION_CACHE_TTL_MS + 1;
    await search(PHOTO);
    expect(detect).toHaveBeenCalledTimes(2);
    expect(await used()).toBe(2);
  });

  it('searches again when the stored entry is damaged', async () => {
    const { search, detect } = setup();
    await search(PHOTO);
    const [key] = await cacheKeys();
    await browser.storage.local.set({ [key as string]: { matches: 'oops', at: NOW } });
    await search(PHOTO);
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('still answers when the cache cannot be written', async () => {
    const { search } = setup();
    const set = browser.storage.local.set.bind(browser.storage.local);
    vi.spyOn(browser.storage.local, 'set').mockImplementation(((items: Record<string, unknown>) =>
      Object.keys(items).some((k) => k.startsWith(VISION_CACHE_PREFIX))
        ? Promise.reject(new Error('quota'))
        : set(items)) as never);
    expect((await search(PHOTO)).status).toBe('ok');
  });
});

describe('createImageSearcher gate', () => {
  it('does nothing without a key', async () => {
    await saveSettings({ keys: { vision: '' } });
    const { search, photo, detect } = setup();
    expect(await search(PHOTO)).toEqual({ status: 'no_key' });
    expect(photo).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
    expect(await used()).toBe(0);
  });

  it('does not call Google when the cap is reached, and counts nothing', async () => {
    await saveSettings({ caps: { vision: 1 } });
    const { search, detect } = setup();
    await search(PHOTO);
    expect(await search('https://images1.vinted.net/t/02/f800/other.webp?s=b')).toEqual({
      status: 'quota',
    });
    expect(detect).toHaveBeenCalledOnce();
    expect(await used()).toBe(1);
  });

  it('takes the cap from the stored settings, whatever a page was told earlier', async () => {
    const { search, detect } = setup();
    expect((await reserve('vision', 1, null)).ok).toBe(true);
    await saveSettings({ caps: { vision: 1 } });
    expect(await search(PHOTO)).toEqual({ status: 'quota' });
    expect(detect).not.toHaveBeenCalled();
    expect(await used()).toBe(1);
  });

  it('has no cap when the cap is null', async () => {
    await saveSettings({ caps: { vision: null } });
    const { search } = setup();
    for (let n = 0; n < 3; n++) {
      expect((await search(`https://images1.vinted.net/t/${n}/f800/p.webp`)).status).toBe('ok');
    }
    expect(await used()).toBe(3);
  });
});

describe('createImageSearcher failures', () => {
  it.each(['invalid', 'disabled', 'restricted', 'billing', 'quota', 'network'] as const)(
    'gives the credit back and reports "%s"',
    async (reason) => {
      const { search } = setup({ ok: false, reason });
      expect(await search(PHOTO)).toEqual({ status: 'error', reason });
      expect(await used()).toBe(0);
      expect(await cacheKeys()).toEqual([]);
    },
  );

  it('treats a Vision call that throws as a network failure and refunds', async () => {
    const { search } = setup(new Error('boom'));
    expect(await search(PHOTO)).toEqual({ status: 'error', reason: 'network' });
    expect(await used()).toBe(0);
  });

  it('can try again after a failure, and pays once for the success', async () => {
    const detect = vi
      .fn<(base64: string, key: string) => Promise<WebDetectResult>>()
      .mockResolvedValueOnce({ ok: false, reason: 'network' })
      .mockResolvedValueOnce(FOUND);
    const search = createImageSearcher({
      fetchPhoto: () => Promise.resolve(new Blob([BYTES])),
      webDetect: detect,
      now: () => clock,
    });
    expect((await search(PHOTO)).status).toBe('error');
    expect((await search(PHOTO)).status).toBe('ok');
    expect(await used()).toBe(1);
  });

  it('reports a photo that cannot be downloaded, without reserving anything', async () => {
    const { search, detect } = setup(FOUND, () => Promise.reject(new Error('HTTP 404')));
    expect(await search(PHOTO)).toEqual({ status: 'error', reason: 'photo' });
    expect(detect).not.toHaveBeenCalled();
    expect(await used()).toBe(0);
  });

  it('never rejects, even when storage fails', async () => {
    const { search } = setup();
    vi.spyOn(browser.storage.local, 'get').mockRejectedValue(new Error('storage down'));
    expect(await search(PHOTO)).toEqual({ status: 'error', reason: 'network' });
  });
});

describe('createImageSearcher URL validation', () => {
  it.each([
    'https://evil.example/a.jpg',
    'http://images1.vinted.net/a.jpg',
    'https://images1.vinted.net:8443/a.jpg',
    'https://user:pw@images1.vinted.net/a.jpg',
    'https://images1.vinted.net.evil.example/a.jpg',
    'data:image/png;base64,AAAA',
    'not a url',
    '',
  ])('refuses %s without touching the network, the settings or the cache', async (url) => {
    const { search, photo, detect } = setup();
    expect(await search(url)).toEqual({ status: 'error', reason: 'photo' });
    expect(photo).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
    expect(await used()).toBe(0);
  });
});

describe('createImageSearcher in flight', () => {
  it('searches a photo asked twice at once only once', async () => {
    let release: (value: WebDetectResult) => void = () => undefined;
    const detect = vi.fn(
      () =>
        new Promise<WebDetectResult>((resolve) => {
          release = resolve;
        }),
    );
    const photo = vi.fn(() => Promise.resolve(new Blob([BYTES])));
    const search = createImageSearcher({ fetchPhoto: photo, webDetect: detect, now: () => clock });

    const first = search(PHOTO);
    const second = search(`${PHOTO}&again=1`);
    await vi.waitFor(() => expect(detect).toHaveBeenCalled());
    release(FOUND);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.status).toBe('ok');
    expect(detect).toHaveBeenCalledOnce();
    expect(photo).toHaveBeenCalledOnce();
    expect(await used()).toBe(1);
  });

  it('searches two different photos separately', async () => {
    const { search, detect } = setup();
    await Promise.all([
      search('https://images1.vinted.net/t/1/f800/a.webp'),
      search('https://images1.vinted.net/t/2/f800/b.webp'),
    ]);
    expect(detect).toHaveBeenCalledTimes(2);
    expect(await used()).toBe(2);
  });

  it('forgets an in-flight search once it is over', async () => {
    const { search, detect } = setup({ ok: false, reason: 'network' });
    await search(PHOTO);
    await search(PHOTO);
    expect(detect).toHaveBeenCalledTimes(2);
  });
});
