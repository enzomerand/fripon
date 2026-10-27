import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { REVIEW_LIMITS, type AiReviewInput } from '../ai/input';
import { aiCacheKey, writeAiCache } from '../ai/review-cache';
import { KEY_FAILURE_MEMO_MS, TRANSIENT_FAILURE_MEMO_MS } from '../google/failure-memo';
import { isKeyFailure } from '../google/refusal';
import { VISION_CACHE_PREFIX, visionCacheKey, writeVisionCache } from '../image/search-cache';
import type { ImageMatch } from '../model';
import type { CloudClient } from './client';
import { STATUS_AFTER_REFUSAL_MS } from './config';
import type { StatusKeeper } from './status';
import { createCloudSteps } from './steps';
import { PLAN_USAGE, makeClient } from './test-helpers';

const PHOTO = 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa';
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const MATCHES: ImageMatch[] = [
  { platform: 'Shein', url: 'https://fr.shein.com/Robe-p-1.html', exact: true, price: null },
];
const INPUT: AiReviewInput = {
  photoUrl: PHOTO,
  title: 'Robe fleurie',
  description: 'Jamais portée.',
  price: '12,00 €',
  signals: ['Recherche d’image : aucune trace.'],
  fingerprint: ['image:none'],
};
const REVIEW = { catalogPhoto: false, summary: 'Rien de suspect.' };

let clock = NOW;

function setup(client: CloudClient = makeClient(), token: string | null = 'tok-1') {
  const status: StatusKeeper = {
    current: vi.fn(() => Promise.resolve(null)),
    record: vi.fn(() => Promise.resolve()),
  };
  const steps = createCloudSteps({
    client,
    status,
    token: () => Promise.resolve(token),
    now: () => clock,
  });
  return { steps, client, status };
}

const cacheKeys = async () =>
  Object.keys(await browser.storage.local.get(null)).filter((k) =>
    k.startsWith(VISION_CACHE_PREFIX),
  );

beforeEach(() => {
  fakeBrowser.reset();
  clock = NOW;
});

describe('searchImage', () => {
  it('refuses a photo that is not a Vinted image, before anything else', async () => {
    const { steps, client } = setup();
    for (const url of ['https://evil.test/a.jpg', 'http://images1.vinted.net/a.jpg', 'nope']) {
      expect(await steps.searchImage(url)).toEqual({ status: 'error', reason: 'photo' });
      expect(await steps.searchImage(url, true)).toEqual({ status: 'error', reason: 'photo' });
    }
    expect(client.search).not.toHaveBeenCalled();
  });

  it('asks the server, answers with the matches, and keeps them in the local cache', async () => {
    const { steps, client } = setup(
      makeClient({
        search: vi.fn(() =>
          Promise.resolve({
            ok: true as const,
            matches: MATCHES,
            charged: true,
            usage: PLAN_USAGE,
          }),
        ),
      }),
    );
    expect(await steps.searchImage(PHOTO)).toEqual({ status: 'ok', matches: MATCHES });
    expect(client.search).toHaveBeenCalledWith(PHOTO);
    expect(await cacheKeys()).toEqual([visionCacheKey(PHOTO)]);

    // The same listing again: this browser answers, the server is not asked.
    expect(await steps.searchImage(PHOTO)).toEqual({ status: 'ok', matches: MATCHES });
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('answers from the cache of the personal mode too, with no request', async () => {
    await writeVisionCache(visionCacheKey(PHOTO), MATCHES, NOW - 1000);
    const { steps, client } = setup();
    expect(await steps.searchImage(PHOTO)).toEqual({ status: 'ok', matches: MATCHES });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('never goes further than the cache with cacheOnly ("Au clic")', async () => {
    const { steps, client } = setup();
    expect(await steps.searchImage(PHOTO, true)).toEqual({ status: 'not_cached' });
    await writeVisionCache(visionCacheKey(PHOTO), MATCHES, NOW);
    expect(await steps.searchImage(PHOTO, true)).toEqual({ status: 'ok', matches: MATCHES });
    expect(client.search).not.toHaveBeenCalled();
    expect(client.me).not.toHaveBeenCalled();
  });

  it('hands the server count to the status', async () => {
    const { steps, status } = setup();
    await steps.searchImage(PHOTO);
    expect(status.record).toHaveBeenCalledWith(PLAN_USAGE);
  });

  it('answers quota when the server refuses the analysis, and reads the account again soon', async () => {
    const { steps, status } = setup(
      makeClient({
        search: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'quota' as const })),
      }),
    );
    expect(await steps.searchImage(PHOTO)).toEqual({ status: 'quota' });
    expect(status.current).toHaveBeenCalledWith(STATUS_AFTER_REFUSAL_MS);
    expect(await cacheKeys()).toEqual([]);
  });

  it('answers no_key when signed out, with or without a request', async () => {
    const none = setup(makeClient(), null);
    expect(await none.steps.searchImage(PHOTO)).toEqual({ status: 'no_key' });
    expect(none.client.search).not.toHaveBeenCalled();

    const refused = setup(
      makeClient({
        search: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'signed_out' as const })),
      }),
    );
    expect(await refused.steps.searchImage(PHOTO)).toEqual({ status: 'no_key' });
  });

  it.each([
    ['photo', 'photo'],
    ['rate_limited', 'network'],
    ['network', 'network'],
    ['unavailable', 'unavailable'],
  ] as const)('answers a server failure %s with the word %s', async (reason, word) => {
    const { steps } = setup(
      makeClient({ search: vi.fn(() => Promise.resolve({ ok: false as const, reason })) }),
    );
    expect(await steps.searchImage(PHOTO)).toEqual({ status: 'error', reason: word });
  });

  it('never says a word that sends the user to check a key', async () => {
    const reasons = ['photo', 'rate_limited', 'network', 'unavailable'] as const;
    for (const reason of reasons) {
      const { steps } = setup(
        makeClient({ search: vi.fn(() => Promise.resolve({ ok: false as const, reason })) }),
      );
      const answer = await steps.searchImage(PHOTO, false, true);
      expect(answer.status).toBe('error');
      if (answer.status === 'error') expect(isKeyFailure(answer.reason)).toBe(false);
    }
  });

  it('never rejects, whatever the client does', async () => {
    const { steps } = setup(makeClient({ search: vi.fn(() => Promise.reject(new Error('boom'))) }));
    expect(await steps.searchImage(PHOTO)).toEqual({ status: 'error', reason: 'network' });
  });

  it('does not ask again for a minute and a half after a failure, unless the user clicks', async () => {
    const search = vi.fn<CloudClient['search']>(() =>
      Promise.resolve({ ok: false as const, reason: 'unavailable' as const }),
    );
    const { steps } = setup(makeClient({ search }));
    expect(await steps.searchImage(PHOTO)).toEqual({ status: 'error', reason: 'unavailable' });
    expect(await steps.searchImage(PHOTO)).toEqual({ status: 'error', reason: 'unavailable' });
    expect(search).toHaveBeenCalledTimes(1);

    // A click asks again.
    await steps.searchImage(PHOTO, false, true);
    expect(search).toHaveBeenCalledTimes(2);

    clock += TRANSIENT_FAILURE_MEMO_MS + 1;
    await steps.searchImage(PHOTO);
    expect(search).toHaveBeenCalledTimes(3);
    // It is the same short memory as a key's: far shorter than a refused key's.
    expect(TRANSIENT_FAILURE_MEMO_MS).toBeLessThan(KEY_FAILURE_MEMO_MS);
  });

  it('forgets the failure once the server answers again', async () => {
    const search = vi
      .fn<CloudClient['search']>()
      .mockResolvedValueOnce({ ok: false, reason: 'network' })
      .mockResolvedValue({ ok: true, matches: MATCHES, charged: true, usage: null });
    const { steps } = setup(makeClient({ search }));
    await steps.searchImage(PHOTO);
    expect((await steps.searchImage(PHOTO, false, true)).status).toBe('ok');
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('does not remember a photo the server cannot use: the next listing deserves its own try', async () => {
    const search = vi.fn<CloudClient['search']>(() =>
      Promise.resolve({ ok: false as const, reason: 'photo' as const }),
    );
    const { steps } = setup(makeClient({ search }));
    await steps.searchImage(PHOTO);
    await steps.searchImage(PHOTO);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('asks the server once for the same photo asked twice at once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const search = vi.fn<CloudClient['search']>(async () => {
      await gate;
      return { ok: true as const, matches: MATCHES, charged: true, usage: null };
    });
    const { steps } = setup(makeClient({ search }));
    const both = Promise.all([steps.searchImage(PHOTO), steps.searchImage(PHOTO)]);
    await vi.waitFor(() => expect(search).toHaveBeenCalled());
    release();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('aiReview', () => {
  it('refuses a photo that is not a Vinted image, before anything else', async () => {
    const { steps, client } = setup();
    const bad = { ...INPUT, photoUrl: 'https://evil.test/a.jpg' };
    expect(await steps.aiReview(bad)).toEqual({ status: 'error', reason: 'photo' });
    expect(await steps.aiReview(bad, true)).toEqual({ status: 'error', reason: 'photo' });
    expect(client.review).not.toHaveBeenCalled();
  });

  it('asks the server with the clamped input, answers, and keeps the review in the local cache', async () => {
    const { steps, client } = setup(
      makeClient({ review: vi.fn(() => Promise.resolve({ ok: true as const, review: REVIEW })) }),
    );
    const long = { ...INPUT, title: 'T'.repeat(REVIEW_LIMITS.title + 50) };
    expect(await steps.aiReview(long)).toEqual({ status: 'ok', review: REVIEW });
    const sent = vi.mocked(client.review).mock.calls[0]?.[0];
    expect(sent?.title).toHaveLength(REVIEW_LIMITS.title);

    expect(await steps.aiReview(long)).toEqual({ status: 'ok', review: REVIEW });
    expect(client.review).toHaveBeenCalledTimes(1);
  });

  it('answers from the cache of the personal mode too, with no request', async () => {
    await writeAiCache(aiCacheKey(PHOTO, INPUT), REVIEW, NOW - 1000);
    const { steps, client } = setup();
    expect(await steps.aiReview(INPUT)).toEqual({ status: 'ok', review: REVIEW });
    expect(client.review).not.toHaveBeenCalled();
  });

  it('never goes further than the cache with cacheOnly', async () => {
    const { steps, client } = setup();
    expect(await steps.aiReview(INPUT, true)).toEqual({ status: 'not_cached' });
    await writeAiCache(aiCacheKey(PHOTO, INPUT), REVIEW, NOW);
    expect(await steps.aiReview(INPUT, true)).toEqual({ status: 'ok', review: REVIEW });
    expect(client.review).not.toHaveBeenCalled();
  });

  it('has the server serve a photo it never served to this account, then asks again, once', async () => {
    const review = vi
      .fn<CloudClient['review']>()
      .mockResolvedValueOnce({ ok: false, reason: 'not_searched' })
      .mockResolvedValue({ ok: true, review: REVIEW });
    const { steps, client, status } = setup(makeClient({ review }));
    expect(await steps.aiReview(INPUT)).toEqual({ status: 'ok', review: REVIEW });
    expect(client.search).toHaveBeenCalledWith(PHOTO);
    expect(review).toHaveBeenCalledTimes(2);
    expect(status.record).toHaveBeenCalledWith(PLAN_USAGE);
    // The search that was made is kept like any other.
    expect(await cacheKeys()).toEqual([visionCacheKey(PHOTO)]);
  });

  it('gives up when the server still refuses, and does not loop', async () => {
    const review = vi.fn<CloudClient['review']>(() =>
      Promise.resolve({ ok: false as const, reason: 'not_searched' as const }),
    );
    const { steps, client } = setup(makeClient({ review }));
    expect(await steps.aiReview(INPUT)).toEqual({ status: 'error', reason: 'unavailable' });
    expect(review).toHaveBeenCalledTimes(2);
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('answers quota when that search is refused for want of analyses', async () => {
    const { steps, client } = setup(
      makeClient({
        review: vi.fn(() =>
          Promise.resolve({ ok: false as const, reason: 'not_searched' as const }),
        ),
        search: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'quota' as const })),
      }),
    );
    expect(await steps.aiReview(INPUT)).toEqual({ status: 'quota' });
    expect(client.review).toHaveBeenCalledTimes(1);
  });

  it('answers no_key when signed out', async () => {
    const none = setup(makeClient(), null);
    expect(await none.steps.aiReview(INPUT)).toEqual({ status: 'no_key' });
    expect(none.client.review).not.toHaveBeenCalled();

    const refused = setup(
      makeClient({
        review: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'signed_out' as const })),
      }),
    );
    expect(await refused.steps.aiReview(INPUT)).toEqual({ status: 'no_key' });
  });

  it.each([
    ['photo', 'photo'],
    ['rate_limited', 'network'],
    ['network', 'network'],
    ['unavailable', 'unavailable'],
    ['invalid_answer', 'invalid_answer'],
  ] as const)('answers a server failure %s with the word %s', async (reason, word) => {
    const { steps } = setup(
      makeClient({ review: vi.fn(() => Promise.resolve({ ok: false as const, reason })) }),
    );
    const answer = await steps.aiReview(INPUT);
    expect(answer).toEqual({ status: 'error', reason: word });
    if (answer.status === 'error') expect(isKeyFailure(answer.reason)).toBe(false);
  });

  it('never rejects, whatever the client does', async () => {
    const { steps } = setup(makeClient({ review: vi.fn(() => Promise.reject(new Error('boom'))) }));
    expect(await steps.aiReview(INPUT)).toEqual({ status: 'error', reason: 'network' });
  });

  it('does not ask again for a minute and a half after a failure, unless the user clicks', async () => {
    const review = vi.fn<CloudClient['review']>(() =>
      Promise.resolve({ ok: false as const, reason: 'network' as const }),
    );
    const { steps } = setup(makeClient({ review }));
    await steps.aiReview(INPUT);
    await steps.aiReview(INPUT);
    expect(review).toHaveBeenCalledTimes(1);
    await steps.aiReview(INPUT, false, true);
    expect(review).toHaveBeenCalledTimes(2);
    clock += TRANSIENT_FAILURE_MEMO_MS + 1;
    await steps.aiReview(INPUT);
    expect(review).toHaveBeenCalledTimes(3);
  });

  it('keeps the memory of the search and the one of the review apart', async () => {
    const { steps, client } = setup(
      makeClient({
        search: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'network' as const })),
      }),
    );
    await steps.searchImage(PHOTO);
    expect((await steps.aiReview(INPUT)).status).toBe('ok');
    expect(client.review).toHaveBeenCalledTimes(1);
  });

  it('asks the server once for the same review asked twice at once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const review = vi.fn<CloudClient['review']>(async () => {
      await gate;
      return { ok: true as const, review: REVIEW };
    });
    const { steps } = setup(makeClient({ review }));
    const both = Promise.all([steps.aiReview(INPUT), steps.aiReview(INPUT)]);
    await vi.waitFor(() => expect(review).toHaveBeenCalled());
    release();
    await both;
    expect(review).toHaveBeenCalledTimes(1);
  });
});
