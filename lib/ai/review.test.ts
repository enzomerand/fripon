import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getUsage, reserve } from '../credits';
import type { ReviewInput, ReviewResult } from '../google/gemini';
import { KEY_FAILURE_MEMO_MS } from '../image/search';
import type { AiReview } from '../model';
import { saveSettings } from '../settings';
import type { AiReviewInput } from './input';
import { createAiReviewer, mimeTypeOf } from './review';
import { AI_CACHE_PREFIX, AI_CACHE_TTL_MS } from './review-cache';

const KEY = 'AIzaSyFakeKeyForTestsOnly_0123456789abcd';
const PHOTO = 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa';
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const BYTES = new Uint8Array([1, 2, 3]);

const INPUT: AiReviewInput = {
  photoUrl: PHOTO,
  title: 'Robe fleurie',
  description: 'Robe portée une fois.',
  price: '12,00 €',
  signals: ['La photo est identique à celle d’articles vendus sur Shein.'],
};
const REVIEW: AiReview = { catalogPhoto: true, summary: 'La photo vient de Shein.' };
const FOUND: ReviewResult = { ok: true, review: REVIEW };

let clock = NOW;

function setup(
  result: ReviewResult | Error = FOUND,
  fetchPhoto: () => Promise<Blob> = () =>
    Promise.resolve(new Blob([BYTES], { type: 'image/webp' })),
) {
  const photo = vi.fn(fetchPhoto);
  const call = vi.fn<(input: ReviewInput, key: string) => Promise<ReviewResult>>(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  const review = createAiReviewer({ fetchPhoto: photo, reviewListing: call, now: () => clock });
  return { review, photo, call };
}

const used = async () => (await getUsage('gemini', null)).used;
const cacheKeys = async () =>
  Object.keys(await browser.storage.local.get(null)).filter((k) => k.startsWith(AI_CACHE_PREFIX));

beforeEach(async () => {
  fakeBrowser.reset();
  clock = NOW;
  await saveSettings({ keys: { gemini: KEY } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mimeTypeOf', () => {
  it('keeps the types Gemini reads', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
      expect(mimeTypeOf(new Blob([BYTES], { type }))).toBe(type);
    }
  });

  it('normalises a type with parameters or capitals', () => {
    expect(mimeTypeOf(new Blob([BYTES], { type: 'Image/WEBP; charset=binary' }))).toBe(
      'image/webp',
    );
  });

  it('falls back to JPEG for a missing or unknown type', () => {
    expect(mimeTypeOf(new Blob([BYTES]))).toBe('image/jpeg');
    expect(mimeTypeOf(new Blob([BYTES], { type: 'application/octet-stream' }))).toBe('image/jpeg');
    expect(mimeTypeOf(new Blob([BYTES], { type: 'image/gif' }))).toBe('image/jpeg');
  });
});

describe('createAiReviewer review', () => {
  it('sends the photo and the listing to Gemini with the saved key and returns the review', async () => {
    const { review, photo, call } = setup();
    const result = await review(INPUT);

    expect(photo).toHaveBeenCalledWith(PHOTO);
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith(
      {
        photo: { mimeType: 'image/webp', base64: 'AQID' },
        title: INPUT.title,
        description: INPUT.description,
        price: INPUT.price,
        signals: INPUT.signals,
      },
      KEY,
    );
    expect(result).toEqual({ status: 'ok', review: REVIEW });
  });

  it('spends exactly one Gemini credit, and none of Vision', async () => {
    const { review } = setup();
    await review(INPUT);
    expect(await used()).toBe(1);
    expect((await getUsage('vision', null)).used).toBe(0);
  });

  it('sends Gemini no more than the limits allow, whatever the page sent', async () => {
    const { review, call } = setup();
    await review({ ...INPUT, description: 'd'.repeat(5_000), signals: Array(30).fill('s') });
    const sent = call.mock.calls[0]?.[0];
    expect(sent?.description).toHaveLength(1_500);
    expect(sent?.signals).toHaveLength(12);
  });

  it('never puts the key or the raw photo in the response', async () => {
    const { review } = setup();
    const json = JSON.stringify(await review(INPUT));
    expect(json).not.toContain(KEY);
    expect(json).not.toContain('AQID');
  });

  it('reviews a photo of a kind Gemini does not announce as JPEG', async () => {
    const { review, call } = setup(FOUND, () => Promise.resolve(new Blob([BYTES])));
    await review(INPUT);
    expect(call.mock.calls[0]?.[0].photo.mimeType).toBe('image/jpeg');
  });
});

describe('createAiReviewer cache', () => {
  it('answers a listing reviewed before without calling anything, for free', async () => {
    const first = setup();
    const result = await first.review(INPUT);
    expect(await cacheKeys()).toHaveLength(1);
    expect((await cacheKeys())[0]).toMatch(
      /^fripon:ai:v1:https:\/\/images1\.vinted\.net\/t\/01_a\/f800\/main\.webp:[0-9a-f]{8}$/,
    );

    // A new reviewer (the service worker restarted), the same picture with another signature.
    const again = setup();
    expect(
      await again.review({
        ...INPUT,
        photoUrl: 'https://images1.vinted.net/t/01_a/f800/main.webp?s=zz',
      }),
    ).toEqual(result);
    expect(again.photo).not.toHaveBeenCalled();
    expect(again.call).not.toHaveBeenCalled();
    expect(await used()).toBe(1);
  });

  it('reviews again when the price, the title or the signals changed', async () => {
    const { review, call } = setup();
    await review(INPUT);
    await review({ ...INPUT, price: '9,00 €' });
    await review({ ...INPUT, title: 'Robe à fleurs' });
    await review({ ...INPUT, signals: ['Recherche d’image : non faite.'] });
    expect(call).toHaveBeenCalledTimes(4);
    expect(await used()).toBe(4);
  });

  it('does not review again when only the description changed', async () => {
    const { review, call } = setup();
    await review(INPUT);
    await review({ ...INPUT, description: 'Un tout autre texte.' });
    expect(call).toHaveBeenCalledOnce();
  });

  it('serves the cache even without a key, or with the cap reached', async () => {
    const { review } = setup();
    await review(INPUT);
    await saveSettings({ keys: { gemini: '' } });
    expect((await review(INPUT)).status).toBe('ok');
    await saveSettings({ keys: { gemini: KEY }, caps: { gemini: 1 } });
    expect((await review(INPUT)).status).toBe('ok');
  });

  it('reviews again after 7 days', async () => {
    const { review, call } = setup();
    await review(INPUT);
    clock = NOW + AI_CACHE_TTL_MS;
    await review(INPUT);
    expect(call).toHaveBeenCalledOnce();
    clock = NOW + AI_CACHE_TTL_MS + 1;
    await review(INPUT);
    expect(call).toHaveBeenCalledTimes(2);
    expect(await used()).toBe(2);
  });

  it('reviews again when the stored entry is damaged', async () => {
    const { review, call } = setup();
    await review(INPUT);
    const [key] = await cacheKeys();
    await browser.storage.local.set({ [key as string]: { review: 'oops', at: NOW } });
    await review(INPUT);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('still answers when the cache cannot be written', async () => {
    const { review } = setup();
    const set = browser.storage.local.set.bind(browser.storage.local);
    vi.spyOn(browser.storage.local, 'set').mockImplementation(((items: Record<string, unknown>) =>
      Object.keys(items).some((k) => k.startsWith(AI_CACHE_PREFIX))
        ? Promise.reject(new Error('quota'))
        : set(items)) as never);
    expect((await review(INPUT)).status).toBe('ok');
  });
});

describe('createAiReviewer gate', () => {
  it('does nothing without a key: no download, no call, no credit', async () => {
    await saveSettings({ keys: { gemini: '' } });
    const { review, photo, call } = setup();
    expect(await review(INPUT)).toEqual({ status: 'no_key' });
    expect(photo).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(await used()).toBe(0);
  });

  it('ignores a Vision key', async () => {
    await saveSettings({ keys: { gemini: '', vision: KEY } });
    const { review } = setup();
    expect(await review(INPUT)).toEqual({ status: 'no_key' });
  });

  it('answers quota before downloading anything when the cap is reached, and counts nothing', async () => {
    await saveSettings({ caps: { gemini: 1 } });
    const { review, photo, call } = setup();
    await review(INPUT);
    expect(photo).toHaveBeenCalledOnce();
    expect(await review({ ...INPUT, price: '9,00 €' })).toEqual({ status: 'quota' });
    expect(photo).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledOnce();
    expect(await used()).toBe(1);
  });

  it('takes the cap from the stored settings, whatever a page was told earlier', async () => {
    const { review, photo, call } = setup();
    expect((await reserve('gemini', 1, null)).ok).toBe(true);
    await saveSettings({ caps: { gemini: 1 } });
    expect(await review(INPUT)).toEqual({ status: 'quota' });
    expect(photo).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(await used()).toBe(1);
  });

  it('gives the last credit to one of two reviews racing for it', async () => {
    await saveSettings({ caps: { gemini: 1 } });
    const { review, photo, call } = setup();
    const [a, b] = await Promise.all([
      review({ ...INPUT, price: '1,00 €' }),
      review({ ...INPUT, price: '2,00 €' }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['ok', 'quota']);
    // Both passed the cap check and downloaded; only one reserved the credit and called Google.
    expect(photo).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledOnce();
    expect(await used()).toBe(1);
  });

  it('has no cap when the cap is null', async () => {
    await saveSettings({ caps: { gemini: null } });
    const { review } = setup();
    for (let n = 0; n < 3; n++) {
      expect((await review({ ...INPUT, price: `${n} €` })).status).toBe('ok');
    }
    expect(await used()).toBe(3);
  });
});

describe('createAiReviewer failures', () => {
  it.each(['invalid', 'disabled', 'restricted', 'billing', 'quota'] as const)(
    'gives the credit back when Google refused for "%s" without billing',
    async (reason) => {
      const { review } = setup({ ok: false, reason, refundable: true });
      expect(await review(INPUT)).toEqual({ status: 'error', reason });
      expect(await used()).toBe(0);
      expect(await cacheKeys()).toEqual([]);
    },
  );

  it.each(['network', 'photo', 'invalid', 'quota', 'invalid_answer'] as const)(
    'keeps the credit when the call may have been billed ("%s")',
    async (reason) => {
      const { review } = setup({ ok: false, reason, refundable: false });
      expect(await review(INPUT)).toEqual({ status: 'error', reason });
      expect(await used()).toBe(1);
      expect(await cacheKeys()).toEqual([]);
    },
  );

  it('keeps the credit of a Gemini call that throws, and reports a network failure', async () => {
    const { review } = setup(new Error('boom'));
    expect(await review(INPUT)).toEqual({ status: 'error', reason: 'network' });
    expect(await used()).toBe(1);
  });

  it('can try again after a refunded failure, and pays once for the success', async () => {
    const call = vi
      .fn<(input: ReviewInput, key: string) => Promise<ReviewResult>>()
      .mockResolvedValueOnce({ ok: false, reason: 'quota', refundable: true })
      .mockResolvedValueOnce(FOUND);
    const review = createAiReviewer({
      fetchPhoto: () => Promise.resolve(new Blob([BYTES])),
      reviewListing: call,
      now: () => clock,
    });
    expect((await review(INPUT)).status).toBe('error');
    expect((await review(INPUT)).status).toBe('ok');
    expect(await used()).toBe(1);
  });

  it('reports a photo that cannot be downloaded, without reserving anything', async () => {
    const { review, call } = setup(FOUND, () => Promise.reject(new Error('HTTP 404')));
    expect(await review(INPUT)).toEqual({ status: 'error', reason: 'photo' });
    expect(call).not.toHaveBeenCalled();
    expect(await used()).toBe(0);
  });

  it('never rejects, even when storage fails', async () => {
    const { review } = setup();
    vi.spyOn(browser.storage.local, 'get').mockRejectedValue(new Error('storage down'));
    expect(await review(INPUT)).toEqual({ status: 'error', reason: 'network' });
  });
});

describe('createAiReviewer key failures', () => {
  const refused = (reason: 'invalid' | 'restricted' | 'disabled' | 'billing') =>
    ({ ok: false, reason, refundable: true }) as const;
  const OTHER: AiReviewInput = { ...INPUT, price: '99,00 €' };

  it.each(['invalid', 'restricted', 'disabled', 'billing'] as const)(
    'remembers a "%s" key for 10 minutes: no download, no call, no credit for the next listings',
    async (reason) => {
      const { review, photo, call } = setup(refused(reason));
      expect(await review(INPUT)).toEqual({ status: 'error', reason });
      expect(photo).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledOnce();

      clock = NOW + KEY_FAILURE_MEMO_MS - 1;
      expect(await review(OTHER)).toEqual({ status: 'error', reason });
      expect(await review(INPUT)).toEqual({ status: 'error', reason });
      expect(photo).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledOnce();
      expect(await used()).toBe(0);
    },
  );

  it('tries the key again after 10 minutes', async () => {
    const { review, call } = setup(refused('billing'));
    await review(INPUT);
    clock = NOW + KEY_FAILURE_MEMO_MS;
    await review(OTHER);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not remember failures that say nothing about the key', async () => {
    for (const reason of ['network', 'photo', 'quota', 'invalid_answer'] as const) {
      const { review, call } = setup({ ok: false, reason, refundable: true });
      await review(INPUT);
      await review(OTHER);
      expect(call).toHaveBeenCalledTimes(2);
    }
  });

  it('forgets the failure as soon as another key is saved', async () => {
    const { review, call } = setup(refused('invalid'));
    await review(INPUT);
    await saveSettings({ keys: { gemini: `${KEY}2` } });
    await review(OTHER);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]?.[1]).toBe(`${KEY}2`);
  });

  it('forgets the failure when asked to (the key just tested fine)', async () => {
    const { review, call } = setup(refused('billing'));
    await review(INPUT);
    review.forgetKeyFailure();
    await review(OTHER);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('forgets the failure after a success', async () => {
    const call = vi
      .fn<(input: ReviewInput, key: string) => Promise<ReviewResult>>()
      .mockResolvedValueOnce(refused('billing'))
      .mockResolvedValue(FOUND);
    const review = createAiReviewer({
      fetchPhoto: () => Promise.resolve(new Blob([BYTES])),
      reviewListing: call,
      now: () => clock,
    });
    await review(INPUT);
    clock = NOW + KEY_FAILURE_MEMO_MS;
    expect((await review(OTHER)).status).toBe('ok');
    expect((await review({ ...INPUT, price: '3 €' })).status).toBe('ok');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('still serves a cached review while the key is remembered as refused', async () => {
    const call = vi
      .fn<(input: ReviewInput, key: string) => Promise<ReviewResult>>()
      .mockResolvedValueOnce(FOUND)
      .mockResolvedValue(refused('billing'));
    const review = createAiReviewer({
      fetchPhoto: () => Promise.resolve(new Blob([BYTES])),
      reviewListing: call,
      now: () => clock,
    });
    await review(INPUT);
    await review(OTHER);
    expect((await review(INPUT)).status).toBe('ok');
    expect(await review(OTHER)).toEqual({ status: 'error', reason: 'billing' });
  });
});

describe('createAiReviewer cache only', () => {
  it('answers not_cached for a listing never reviewed, touching nothing', async () => {
    const { review, photo, call } = setup();
    expect(await review(INPUT, true)).toEqual({ status: 'not_cached' });
    expect(photo).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(await used()).toBe(0);
  });

  it('answers the cached review for free, even with no key and the cap reached', async () => {
    const { review, call } = setup();
    const result = await review(INPUT);
    await saveSettings({ keys: { gemini: '' }, caps: { gemini: 1 } });

    expect(await review(INPUT, true)).toEqual(result);
    expect(call).toHaveBeenCalledOnce();
    expect(await used()).toBe(1);
  });

  it('answers not_cached when the signals are not the ones that were reviewed', async () => {
    const { review } = setup();
    await review(INPUT);
    expect(await review({ ...INPUT, signals: [] }, true)).toEqual({ status: 'not_cached' });
  });

  it('never calls Gemini, even with a key and credits', async () => {
    const { review, call } = setup();
    await review(INPUT, true);
    await review(INPUT, true);
    expect(call).not.toHaveBeenCalled();
    expect(await used()).toBe(0);
    // A normal review afterwards still works.
    expect((await review(INPUT)).status).toBe('ok');
  });

  it('forgets a cached review after 7 days', async () => {
    const { review } = setup();
    await review(INPUT);
    clock = NOW + AI_CACHE_TTL_MS + 1;
    expect(await review(INPUT, true)).toEqual({ status: 'not_cached' });
  });

  it('refuses a foreign URL like any review', async () => {
    const { review } = setup();
    expect(await review({ ...INPUT, photoUrl: 'https://evil.example/a.jpg' }, true)).toEqual({
      status: 'error',
      reason: 'photo',
    });
  });
});

describe('createAiReviewer URL validation', () => {
  it.each([
    'https://evil.example/a.jpg',
    'http://images1.vinted.net/a.jpg',
    'https://images1.vinted.net:8443/a.jpg',
    'https://user:pw@images1.vinted.net/a.jpg',
    'https://images1.vinted.net.evil.example/a.jpg',
    'data:image/png;base64,AAAA',
    'not a url',
    '',
  ])('refuses %s without touching the network, the settings or the cache', async (photoUrl) => {
    const { review, photo, call } = setup();
    expect(await review({ ...INPUT, photoUrl })).toEqual({ status: 'error', reason: 'photo' });
    expect(photo).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(await used()).toBe(0);
    expect(await cacheKeys()).toEqual([]);
  });
});

describe('createAiReviewer in flight', () => {
  it('reviews a listing asked twice at once only once', async () => {
    let release: (value: ReviewResult) => void = () => undefined;
    const call = vi.fn(
      () =>
        new Promise<ReviewResult>((resolve) => {
          release = resolve;
        }),
    );
    const photo = vi.fn(() => Promise.resolve(new Blob([BYTES])));
    const review = createAiReviewer({ fetchPhoto: photo, reviewListing: call, now: () => clock });

    const first = review(INPUT);
    const second = review({ ...INPUT, photoUrl: `${PHOTO}&again=1` });
    await vi.waitFor(() => expect(call).toHaveBeenCalled());
    release(FOUND);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.status).toBe('ok');
    expect(call).toHaveBeenCalledOnce();
    expect(photo).toHaveBeenCalledOnce();
    expect(await used()).toBe(1);
  });

  it('reviews two different listings separately', async () => {
    const { review, call } = setup();
    await Promise.all([review(INPUT), review({ ...INPUT, price: '1 €' })]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(await used()).toBe(2);
  });

  it('forgets an in-flight review once it is over', async () => {
    const { review, call } = setup({ ok: false, reason: 'network', refundable: false });
    await review(INPUT);
    await review(INPUT);
    expect(call).toHaveBeenCalledTimes(2);
    expect(await used()).toBe(2);
  });
});
