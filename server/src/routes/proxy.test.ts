import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiReviewInput } from '../../../lib/ai/input';
import { aiCacheKey } from '../../../lib/ai/review-key';
import type { ReviewInput, ReviewResult } from '../../../lib/google/gemini';
import type { WebDetectResult } from '../../../lib/google/vision';
import { IMAGE_MAX_BYTES } from '../../../lib/image/guarded-fetch';
import { photoKey } from '../../../lib/image/photo-url';
import { visionCacheKey } from '../../../lib/image/search-entry';
import type { Config } from '../config';
import type { Account } from '../db';
import type { GoogleDeps } from '../google';
import { periodIds } from '../time';
import { createTestApp, post, signIn, testConfig, type TestApp } from '../test-helpers';
import { visionCallsOn } from '../vision-ceiling';
import { registerProxyRoutes, reviewKey, visionKey } from './proxy';

const VISION_KEY = 'AIza-test-vision-key-0001';
const GEMINI_KEY = 'AIza-test-gemini-key-0002';
const PHOTO = 'https://images1.vinted.net/t/01_00a1b/f800/1234567890.jpeg?s=sig1';
const OTHER_PHOTO = 'https://images1.vinted.net/t/01_00a1c/f800/9999999999.jpeg';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const SHEIN_PAGE = 'https://fr.shein.com/Robe-fleurie-p-12345-cat-1727.html';
const DETECTION: WebDetectResult = {
  ok: true,
  webDetection: {
    pagesWithMatchingImages: [
      { url: SHEIN_PAGE, fullMatchingImages: [{ url: 'https://img/x.jpg' }] },
    ],
  },
};
const REVIEW_TEXT = { catalogPhoto: true, summary: 'La même photo est en vente sur Shein.' };
const REVIEW: ReviewResult = { ok: true, review: REVIEW_TEXT };

/** The fakes behind the Google deps, and what they saw. Each call can be given another answer. */
interface FakeGoogle extends GoogleDeps {
  fetched: Array<{ url: string; init: RequestInit }>;
  detections: Array<{ base64: string; key: string }>;
  reviews: Array<{ input: ReviewInput; key: string }>;
  photoAnswer: () => Response | Promise<Response>;
  detect: () => Promise<WebDetectResult>;
  review: () => Promise<ReviewResult>;
}

const jpeg = () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });

function fakeGoogle(): FakeGoogle {
  const google: FakeGoogle = {
    fetched: [],
    detections: [],
    reviews: [],
    photoAnswer: jpeg,
    detect: async () => DETECTION,
    review: async () => REVIEW,
    async fetch(url, init) {
      google.fetched.push({ url, init });
      return google.photoAnswer();
    },
    webDetect(base64, key) {
      google.detections.push({ base64, key });
      return google.detect();
    },
    reviewListing(input, key) {
      google.reviews.push({ input, key });
      return google.review();
    },
  };
  return google;
}

function setup(config: Partial<Config> = {}) {
  const google = fakeGoogle();
  const t = createTestApp(
    [registerProxyRoutes(google)],
    testConfig({ googleVisionKey: VISION_KEY, geminiKey: GEMINI_KEY, ...config }),
  );
  return { ...t, google };
}

type Setup = ReturnType<typeof setup>;

interface Person {
  token: string;
  id: string;
  email: string;
}

/** Signs `email` in through the real routes; `patch` then sets any column of the account. */
async function person(t: TestApp, email: string, patch: Partial<Account> = {}): Promise<Person> {
  const token = await signIn(t, email);
  const { id } = t.db.prepare('SELECT id FROM accounts WHERE email = ?').get(email) as {
    id: string;
  };
  const columns = Object.keys(patch);
  if (columns.length > 0) {
    t.db
      .prepare(
        `UPDATE accounts SET ${columns.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`,
      )
      .run({ ...patch, id });
  }
  return { token, id, email };
}

const SUBSCRIBER: Partial<Account> = {
  plan: 'essentiel',
  subscription_status: 'active',
  subscription_id: 'sub_test',
};

const auth = (who: Person) => ({ authorization: `Bearer ${who.token}` });
const search = (t: Setup, who: Person, photoUrl: unknown = PHOTO) =>
  post(t.app, '/v1/search', { photoUrl }, auth(who));
const review = (t: Setup, who: Person, input: unknown = reviewInput()) =>
  post(t.app, '/v1/review', { input }, auth(who));

function reviewInput(overrides: Partial<AiReviewInput> = {}): AiReviewInput {
  const line = "Recherche d'image : la même photo est en vente sur Shein.";
  return {
    photoUrl: PHOTO,
    title: 'Robe fleurie',
    description: 'Jamais portée',
    price: '12,00 €',
    signals: [line],
    fingerprint: [line],
    ...overrides,
  };
}

const usageRows = (t: Setup, who: Person) =>
  (
    t.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE account_id = ?').get(who.id) as {
      n: number;
    }
  ).n;
const trialLeft = (t: Setup, who: Person) =>
  (
    t.db.prepare('SELECT trial_left FROM accounts WHERE id = ?').get(who.id) as {
      trial_left: number;
    }
  ).trial_left;
const reviewsCounted = (t: Setup, who: Person) =>
  (
    t.db.prepare('SELECT count FROM reviews WHERE account_id = ?').get(who.id) as
      { count: number } | undefined
  )?.count ?? 0;
const ceiling = (t: Setup) => visionCallsOn(t.db, periodIds(t.clock.now()).day);

/** Quiets and records the server's error log. */
function captureErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /v1/search', () => {
  it('charges the first search, with the owner key and the photo as base64', async () => {
    const t = setup();
    const ann = await person(t, 'ann@example.com');

    const response = await search(t, ann);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      matches: [{ platform: 'Shein', url: SHEIN_PAGE, exact: true, price: null }],
      charged: true,
      usage: {
        kind: 'trial',
        month: { used: 1, cap: null },
        day: { used: 1, cap: null },
        trialLeft: 14,
      },
    });
    expect(t.google.detections).toEqual([
      { key: VISION_KEY, base64: Buffer.from(JPEG).toString('base64') },
    ]);
    expect(t.google.fetched).toHaveLength(1);
    expect(ceiling(t)).toBe(1);
  });

  it('shows the plan counters of a subscriber', async () => {
    const t = setup();
    const bob = await person(t, 'bob@example.com', SUBSCRIBER);
    const body = (await (await search(t, bob)).json()) as { usage: unknown };
    expect(body.usage).toMatchObject({
      kind: 'plan',
      plan: 'essentiel',
      month: { used: 1, cap: 300 },
      day: { used: 1, cap: 40 },
    });
  });

  it('serves the same photo again free, from the cache, whatever its signature', async () => {
    const t = setup();
    const ann = await person(t, 'ann@example.com');
    await search(t, ann);

    const again = await search(t, ann, `${PHOTO.split('?')[0]}?s=another-signature`);
    expect(await again.json()).toMatchObject({ charged: false, usage: { trialLeft: 14 } });
    expect(t.google.detections).toHaveLength(1);
    expect(usageRows(t, ann)).toBe(1);
  });

  it('answers a second account from the shared cache: one Google call, both charged', async () => {
    const t = setup();
    const ann = await person(t, 'ann@example.com');
    const bob = await person(t, 'bob@example.com');

    const first = await search(t, ann);
    const second = await search(t, bob);
    expect(await first.json()).toMatchObject({ charged: true });
    expect(await second.json()).toMatchObject({ charged: true, usage: { trialLeft: 14 } });
    expect(t.google.detections).toHaveLength(1);
    expect(t.google.fetched).toHaveLength(1);
    expect(ceiling(t)).toBe(1);
    expect(usageRows(t, ann)).toBe(1);
    expect(usageRows(t, bob)).toBe(1);
  });

  it('keeps an empty answer ("found nothing") and serves it from the cache', async () => {
    const t = setup();
    t.google.detect = async () => ({ ok: true, webDetection: {} });
    const ann = await person(t, 'ann@example.com');
    const bob = await person(t, 'bob@example.com');

    expect(await (await search(t, ann)).json()).toMatchObject({ matches: [], charged: true });
    expect(await (await search(t, bob)).json()).toMatchObject({ matches: [], charged: true });
    expect(t.google.detections).toHaveLength(1);
  });

  it('asks Google again once the shared answer is a week old', async () => {
    const t = setup();
    const ann = await person(t, 'ann@example.com');
    const bob = await person(t, 'bob@example.com');
    await search(t, ann);

    t.clock.advance(7 * 24 * 60 * 60 * 1000 + 1);
    await search(t, bob);
    expect(t.google.detections).toHaveLength(2);
  });

  it('keeps its cache keys in step with the extension (no `fripon:` prefix)', () => {
    expect(`fripon:${visionKey(photoKey(PHOTO))}`).toBe(visionCacheKey(PHOTO));
    const input = reviewInput();
    expect(`fripon:${reviewKey(photoKey(PHOTO), input)}`).toBe(aiCacheKey(PHOTO, input));
  });

  describe('quota', () => {
    it('answers 402 `trial` once the free analyses are used up', async () => {
      const t = setup();
      const ann = await person(t, 'ann@example.com', { trial_left: 0 });
      const response = await search(t, ann);
      expect(response.status).toBe(402);
      expect(await response.json()).toEqual({ error: 'quota', reason: 'trial' });
      expect(t.google.fetched).toHaveLength(0);
      expect(t.google.detections).toHaveLength(0);
    });

    it('answers 402 `day` at the plan daily cap, and `month` at its monthly cap', async () => {
      const t = setup();
      const bob = await person(t, 'bob@example.com', SUBSCRIBER);
      const { day, month } = periodIds(t.clock.now());
      const insert = t.db.prepare(
        "INSERT INTO usage (account_id, photo_key, month, day, kind, served_at) VALUES (?, ?, ?, ?, 'plan', 0)",
      );

      for (let i = 0; i < 40; i++) insert.run(bob.id, `k${i}`, month, day);
      let response = await search(t, bob);
      expect(response.status).toBe(402);
      expect(await response.json()).toEqual({ error: 'quota', reason: 'day' });

      t.db.prepare('DELETE FROM usage').run();
      for (let i = 0; i < 300; i++) insert.run(bob.id, `k${i}`, month, '2026-10-01');
      response = await search(t, bob);
      expect(response.status).toBe(402);
      expect(await response.json()).toEqual({ error: 'quota', reason: 'month' });
      expect(t.google.detections).toHaveLength(0);
    });

    it('answers 402 `none` once the subscription ended and the trial is used', async () => {
      const t = setup();
      const cat = await person(t, 'cat@example.com', {
        ...SUBSCRIBER,
        subscription_status: 'canceled',
        trial_left: 0,
      });
      const response = await search(t, cat);
      expect(response.status).toBe(402);
      expect(await response.json()).toEqual({ error: 'quota', reason: 'none' });
    });

    it('refuses before the cache: a photo already cached still costs a quota check', async () => {
      const t = setup();
      const ann = await person(t, 'ann@example.com');
      const dan = await person(t, 'dan@example.com', { trial_left: 0 });
      await search(t, ann);
      expect((await search(t, dan)).status).toBe(402);
    });
  });

  describe('a failure costs the account nothing', () => {
    it('releases the analysis when the photo cannot be downloaded, and the ceiling gets its call back', async () => {
      const t = setup();
      t.google.photoAnswer = () => new Response('gone', { status: 404 });
      const ann = await person(t, 'ann@example.com');

      const response = await search(t, ann);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'upstream', reason: 'photo' });
      expect(usageRows(t, ann)).toBe(0);
      expect(trialLeft(t, ann)).toBe(15);
      expect(t.google.detections).toHaveLength(0);
      expect(ceiling(t)).toBe(0);
    });

    it('releases the analysis when Google fails, and keeps the ceiling call that may have been billed', async () => {
      const t = setup();
      t.google.detect = async () => ({ ok: false, reason: 'network', refundable: false });
      const ann = await person(t, 'ann@example.com');

      const response = await search(t, ann);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'upstream', reason: 'network' });
      expect(usageRows(t, ann)).toBe(0);
      expect(trialLeft(t, ann)).toBe(15);
      expect(ceiling(t)).toBe(1);
    });

    it('gives the ceiling its call back when Google certainly did not bill', async () => {
      const t = setup();
      t.google.detect = async () => ({ ok: false, reason: 'quota', refundable: true });
      const ann = await person(t, 'ann@example.com');
      captureErrors();

      expect((await search(t, ann)).status).toBe(502);
      expect(ceiling(t)).toBe(0);
    });

    it('reads a Google call that throws as a network failure', async () => {
      const t = setup();
      t.google.detect = async () => {
        throw new Error('boom');
      };
      const ann = await person(t, 'ann@example.com');

      const response = await search(t, ann);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'upstream', reason: 'network' });
      expect(usageRows(t, ann)).toBe(0);
    });

    it('reports a photo Google cannot read as `photo`, and releases', async () => {
      const t = setup();
      t.google.detect = async () => ({ ok: false, reason: 'photo', refundable: false });
      const ann = await person(t, 'ann@example.com');

      expect(await (await search(t, ann)).json()).toEqual({ error: 'upstream', reason: 'photo' });
      expect(usageRows(t, ann)).toBe(0);
    });

    it('answers 502 `unavailable` and logs loudly when Google refuses the owner key', async () => {
      const t = setup();
      t.google.detect = async () => ({ ok: false, reason: 'billing', refundable: true });
      const ann = await person(t, 'ann@example.com');
      const log = captureErrors();

      const response = await search(t, ann);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'upstream', reason: 'unavailable' });
      expect(usageRows(t, ann)).toBe(0);
      expect(trialLeft(t, ann)).toBe(15);

      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain('OWNER KEY PROBLEM');
      expect(line).toContain('billing');
      // Nothing of the user, nothing of the key, nothing of the photo.
      for (const secret of [ann.email, ann.token, VISION_KEY, PHOTO, 'vinted.net']) {
        expect(line).not.toContain(secret);
      }
    });

    it('logs the same owner problem once a minute, not at every request', async () => {
      const t = setup();
      t.google.detect = async () => ({ ok: false, reason: 'invalid', refundable: true });
      const ann = await person(t, 'ann@example.com');
      const log = captureErrors();

      await search(t, ann);
      await search(t, ann, OTHER_PHOTO);
      expect(log).toHaveBeenCalledTimes(1);

      t.clock.advance(61_000);
      await search(t, ann);
      expect(log).toHaveBeenCalledTimes(2);
    });

    it('does not log a plain network failure as an owner problem', async () => {
      const t = setup();
      t.google.detect = async () => ({ ok: false, reason: 'network', refundable: false });
      const ann = await person(t, 'ann@example.com');
      const log = captureErrors();

      await search(t, ann);
      expect(log).not.toHaveBeenCalled();
    });

    it('does not release an analysis that was free: the earlier charge stays', async () => {
      const t = setup();
      const ann = await person(t, 'ann@example.com');
      await search(t, ann);
      // The shared answer is gone and Google fails: the second search of the month is free anyway.
      t.db.prepare('DELETE FROM cache').run();
      t.google.detect = async () => ({ ok: false, reason: 'network', refundable: false });

      expect((await search(t, ann)).status).toBe(502);
      expect(usageRows(t, ann)).toBe(1);
      expect(trialLeft(t, ann)).toBe(14);
    });
  });

  describe('the global daily ceiling', () => {
    it('answers 503 `capacity` once the day is full, and charges nothing', async () => {
      const t = setup({ globalDailyVisionCap: 1 });
      const ann = await person(t, 'ann@example.com');
      const bob = await person(t, 'bob@example.com');
      await search(t, ann);

      const response = await search(t, bob, OTHER_PHOTO);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'capacity' });
      expect(usageRows(t, bob)).toBe(0);
      expect(trialLeft(t, bob)).toBe(15);
      expect(t.google.detections).toHaveLength(1);
      expect(ceiling(t)).toBe(1);
    });

    it('does not count the answers of the cache, which cost nothing', async () => {
      const t = setup({ globalDailyVisionCap: 1 });
      const ann = await person(t, 'ann@example.com');
      const bob = await person(t, 'bob@example.com');
      await search(t, ann);

      expect((await search(t, bob)).status).toBe(200);
      expect(ceiling(t)).toBe(1);
    });

    it('opens again the next day (Paris)', async () => {
      const t = setup({ globalDailyVisionCap: 1 });
      const ann = await person(t, 'ann@example.com');
      await search(t, ann);
      expect((await search(t, ann, OTHER_PHOTO)).status).toBe(503);

      t.clock.advance(24 * 60 * 60 * 1000);
      expect((await search(t, ann, OTHER_PHOTO)).status).toBe(200);
    });
  });

  describe('concurrent searches', () => {
    it('share one Google call, each account paying its own analysis', async () => {
      const t = setup();
      const ann = await person(t, 'ann@example.com');
      const bob = await person(t, 'bob@example.com');
      let answer!: (result: WebDetectResult) => void;
      t.google.detect = () => new Promise((resolve) => (answer = resolve));

      const first = search(t, ann);
      await vi.waitFor(() => expect(t.google.detections).toHaveLength(1));
      const second = search(t, bob);
      // Bob has reserved his analysis and is waiting on Ann's call.
      await vi.waitFor(() => expect(usageRows(t, bob)).toBe(1));
      answer(DETECTION);

      const [one, two] = await Promise.all([first, second]);
      expect(await one.json()).toMatchObject({ charged: true });
      expect(await two.json()).toMatchObject({ charged: true });
      expect(t.google.detections).toHaveLength(1);
      expect(t.google.fetched).toHaveLength(1);
      expect(ceiling(t)).toBe(1);
    });

    it('all fail together, and each account gets its own analysis back', async () => {
      const t = setup();
      const ann = await person(t, 'ann@example.com');
      const bob = await person(t, 'bob@example.com');
      let answer!: (result: WebDetectResult) => void;
      t.google.detect = () => new Promise((resolve) => (answer = resolve));

      const first = search(t, ann);
      await vi.waitFor(() => expect(t.google.detections).toHaveLength(1));
      const second = search(t, bob);
      await vi.waitFor(() => expect(usageRows(t, bob)).toBe(1));
      answer({ ok: false, reason: 'network', refundable: false });

      const [one, two] = await Promise.all([first, second]);
      expect(one.status).toBe(502);
      expect(two.status).toBe(502);
      expect(usageRows(t, ann)).toBe(0);
      expect(usageRows(t, bob)).toBe(0);
      expect(trialLeft(t, ann)).toBe(15);
      expect(trialLeft(t, bob)).toBe(15);
    });

    it('lets the next search try again once the failed one is over', async () => {
      const t = setup();
      const ann = await person(t, 'ann@example.com');
      t.google.detect = async () => ({ ok: false, reason: 'network', refundable: false });
      await search(t, ann);

      t.google.detect = async () => DETECTION;
      expect((await search(t, ann)).status).toBe(200);
      expect(t.google.detections).toHaveLength(2);
    });
  });

  describe('the photo', () => {
    it.each([
      ['http', 'http://images1.vinted.net/t/x/f800/y.jpeg'],
      ['another host', 'https://example.com/t/x/f800/y.jpeg'],
      ['a lookalike host', 'https://images1.vinted.net.evil.example/t/x/f800/y.jpeg'],
      ['a 100x100 thumbnail', 'https://images1.vinted.net/t/x/100x100/y.jpeg'],
      ['a port', 'https://images1.vinted.net:444/t/x/f800/y.jpeg'],
      ['a text that is no address', 'hello'],
      ['an empty text', ''],
    ])(
      'answers 400 `invalid_photo` for %s, before reserving or fetching anything',
      async (_n, url) => {
        const t = setup();
        const ann = await person(t, 'ann@example.com');

        const response = await search(t, ann, url);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_photo' });
        expect(t.google.fetched).toHaveLength(0);
        expect(usageRows(t, ann)).toBe(0);
        expect(ceiling(t)).toBe(0);
      },
    );

    it.each([
      ['no photoUrl', {}],
      ['a number', { photoUrl: 12 }],
      ['an array', [PHOTO]],
    ])('answers 400 `invalid_request` for %s', async (_n, body) => {
      const t = setup();
      const ann = await person(t, 'ann@example.com');
      const response = await post(t.app, '/v1/search', body, auth(ann));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    });

    it('answers 400 `invalid_request` for a body that is not JSON', async () => {
      const t = setup();
      const ann = await person(t, 'ann@example.com');
      const response = await t.app.request('/v1/search', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', ...auth(ann) },
        body: PHOTO,
      });
      expect(response.status).toBe(400);
    });

    it('answers 413 above 16 KB', async () => {
      const t = setup();
      const ann = await person(t, 'ann@example.com');
      const response = await search(t, ann, `${PHOTO}${'a'.repeat(17 * 1024)}`);
      expect(response.status).toBe(413);
    });

    it('refuses a photo that redirects: the download asks for no redirect to be followed', async () => {
      const t = setup();
      // What the real fetch does with `redirect: 'error'` when the CDN answers with a redirect.
      t.google.fetch = async (url, init) => {
        t.google.fetched.push({ url, init });
        if (init.redirect === 'error') throw new TypeError('redirect mode is set to error');
        return jpeg();
      };
      const ann = await person(t, 'ann@example.com');

      const response = await search(t, ann);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'upstream', reason: 'photo' });
      expect(t.google.fetched[0]?.init).toMatchObject({ redirect: 'error', credentials: 'omit' });
      expect(t.google.detections).toHaveLength(0);
      expect(usageRows(t, ann)).toBe(0);
    });

    it('refuses an answer whose final host is not the CDN', async () => {
      const t = setup();
      t.google.photoAnswer = () => {
        const response = jpeg();
        Object.defineProperty(response, 'url', { value: 'https://evil.example/a.jpg' });
        return response;
      };
      const ann = await person(t, 'ann@example.com');

      expect(await (await search(t, ann)).json()).toEqual({ error: 'upstream', reason: 'photo' });
      expect(t.google.detections).toHaveLength(0);
      expect(ceiling(t)).toBe(0);
    });

    it('refuses an answer that is not an image', async () => {
      const t = setup();
      t.google.photoAnswer = () =>
        new Response('<html>', { headers: { 'content-type': 'text/html' } });
      const ann = await person(t, 'ann@example.com');

      expect(await (await search(t, ann)).json()).toEqual({ error: 'upstream', reason: 'photo' });
      expect(t.google.detections).toHaveLength(0);
    });

    it('refuses a photo above 8 MB, and sends nothing to Google', async () => {
      const t = setup();
      t.google.photoAnswer = () =>
        new Response(new Uint8Array(IMAGE_MAX_BYTES + 1), {
          headers: { 'content-type': 'image/jpeg' },
        });
      const ann = await person(t, 'ann@example.com');

      expect(await (await search(t, ann)).json()).toEqual({ error: 'upstream', reason: 'photo' });
      expect(t.google.detections).toHaveLength(0);
      expect(usageRows(t, ann)).toBe(0);
    });
  });

  it('answers 401 without a valid token, before looking at the body', async () => {
    const t = setup();
    for (const headers of [{}, { authorization: 'Bearer nope' }]) {
      const response = await post(t.app, '/v1/search', { photoUrl: PHOTO }, headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
    expect(t.google.fetched).toHaveLength(0);
  });
});

describe('POST /v1/review', () => {
  /** An account that searched `PHOTO`: the review is allowed. */
  async function searched(t: Setup, email = 'ann@example.com', patch: Partial<Account> = {}) {
    const who = await person(t, email, patch);
    expect((await search(t, who)).status).toBe(200);
    return who;
  }

  it('answers the review of a photo the account searched', async () => {
    const t = setup();
    const ann = await searched(t);

    const response = await review(t, ann);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ review: REVIEW_TEXT });
    expect(t.google.reviews).toHaveLength(1);
    expect(t.google.reviews[0]?.key).toBe(GEMINI_KEY);
    expect(t.google.reviews[0]?.input).toMatchObject({
      title: 'Robe fleurie',
      description: 'Jamais portée',
      price: '12,00 €',
      photo: { mimeType: 'image/jpeg', base64: Buffer.from(JPEG).toString('base64') },
    });
    // A review is free: no analysis is charged for it.
    expect(usageRows(t, ann)).toBe(1);
    expect(reviewsCounted(t, ann)).toBe(1);
  });

  it('answers 403 `not_searched` for a photo the account never searched', async () => {
    const t = setup();
    const ann = await person(t, 'ann@example.com');

    const response = await review(t, ann);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'not_searched' });
    expect(t.google.reviews).toHaveLength(0);
    expect(t.google.fetched).toHaveLength(0);
  });

  it('answers 403 for a photo another account searched, not this one', async () => {
    const t = setup();
    await searched(t, 'ann@example.com');
    const bob = await person(t, 'bob@example.com');
    expect((await review(t, bob)).status).toBe(403);
  });

  it('answers 403 once the search is more than 7 days old', async () => {
    const t = setup();
    const ann = await searched(t);
    t.clock.advance(7 * 24 * 60 * 60 * 1000 + 1);
    expect((await review(t, ann)).status).toBe(403);
  });

  it('answers 403 after 3 reviews of the same photo', async () => {
    const t = setup();
    const ann = await searched(t);

    for (let i = 0; i < 3; i++) expect((await review(t, ann)).status).toBe(200);
    const response = await review(t, ann);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'not_searched' });
  });

  it('answers 403 for another photo of the same listing that was not searched', async () => {
    const t = setup();
    const ann = await searched(t);
    expect((await review(t, ann, reviewInput({ photoUrl: OTHER_PHOTO }))).status).toBe(403);
  });

  it('serves a second account from the shared cache: one Gemini call', async () => {
    const t = setup();
    const ann = await searched(t, 'ann@example.com');
    const bob = await searched(t, 'bob@example.com');

    const first = await review(t, ann);
    const second = await review(t, bob, reviewInput({ description: 'A completely other text' }));
    expect(await second.json()).toEqual(await first.json());
    // The description is not part of the key (as in the extension), so Bob's review is a hit.
    expect(t.google.reviews).toHaveLength(1);
    expect(reviewsCounted(t, bob)).toBe(1);
  });

  it('reviews again when what was asked changed: the price, the title, the fingerprint', async () => {
    const t = setup();
    const ann = await searched(t);

    await review(t, ann);
    await review(t, ann, reviewInput({ price: '30,00 €' }));
    expect(t.google.reviews).toHaveLength(2);
  });

  it('shares one Gemini call between concurrent reviews', async () => {
    const t = setup();
    const ann = await searched(t, 'ann@example.com');
    const bob = await searched(t, 'bob@example.com');
    let answer!: (result: ReviewResult) => void;
    t.google.review = () => new Promise((resolve) => (answer = resolve));

    const first = review(t, ann);
    await vi.waitFor(() => expect(t.google.reviews).toHaveLength(1));
    const second = review(t, bob);
    await vi.waitFor(() => expect(reviewsCounted(t, bob)).toBe(1));
    answer(REVIEW);

    const [one, two] = await Promise.all([first, second]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(t.google.reviews).toHaveLength(1);
  });

  it('cuts what the page sent to the extension limits before the prompt sees it', async () => {
    const t = setup();
    const ann = await searched(t);

    await review(t, ann, reviewInput({ title: 'T'.repeat(5_000), description: 'D'.repeat(8_000) }));
    const sent = t.google.reviews[0]?.input;
    expect(sent?.title).toHaveLength(200);
    expect(sent?.description).toHaveLength(1_500);
  });

  describe('a failure costs the account nothing', () => {
    it('gives the review back when Gemini fails', async () => {
      const t = setup();
      const ann = await searched(t);
      t.google.review = async () => ({ ok: false, reason: 'network', refundable: false });

      const response = await review(t, ann);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'upstream', reason: 'network' });
      expect(reviewsCounted(t, ann)).toBe(0);

      // Three tries that failed leave the three that count.
      t.google.review = async () => REVIEW;
      for (let i = 0; i < 3; i++) expect((await review(t, ann)).status).toBe(200);
    });

    it('gives the review back for an answer that cannot be used', async () => {
      const t = setup();
      const ann = await searched(t);
      t.google.review = async () => ({ ok: false, reason: 'invalid_answer', refundable: false });

      const response = await review(t, ann);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'upstream', reason: 'invalid_answer' });
      expect(reviewsCounted(t, ann)).toBe(0);
    });

    it('reads a Gemini call that throws as a network failure', async () => {
      const t = setup();
      const ann = await searched(t);
      t.google.review = async () => {
        throw new Error('boom');
      };

      expect(await (await review(t, ann)).json()).toEqual({ error: 'upstream', reason: 'network' });
      expect(reviewsCounted(t, ann)).toBe(0);
    });

    it('gives the review back when the photo cannot be downloaded', async () => {
      const t = setup();
      const ann = await searched(t);
      t.google.photoAnswer = () => new Response('gone', { status: 404 });

      expect(await (await review(t, ann)).json()).toEqual({ error: 'upstream', reason: 'photo' });
      expect(t.google.reviews).toHaveLength(0);
      expect(reviewsCounted(t, ann)).toBe(0);
    });

    it('answers 502 `unavailable` and logs loudly when Google refuses the owner key', async () => {
      const t = setup();
      const ann = await searched(t);
      t.google.review = async () => ({ ok: false, reason: 'disabled', refundable: true });
      const log = captureErrors();

      const response = await review(t, ann);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'upstream', reason: 'unavailable' });
      expect(reviewsCounted(t, ann)).toBe(0);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain('OWNER KEY PROBLEM');
      expect(line).toContain('gemini');
      for (const secret of [ann.email, ann.token, GEMINI_KEY, PHOTO]) {
        expect(line).not.toContain(secret);
      }
    });
  });

  describe('the request', () => {
    it.each([
      ['no input', {}],
      ['an input that is not an object', { input: 'x' }],
      ['an input with a missing field', { input: { photoUrl: PHOTO, title: 'x' } }],
      ['signals that are not text', { input: { ...reviewInput(), signals: [1] } }],
    ])('answers 400 `invalid_request` for %s', async (_n, body) => {
      const t = setup();
      const ann = await person(t, 'ann@example.com');
      const response = await post(t.app, '/v1/review', body, auth(ann));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    });

    it.each([
      ['http', 'http://images1.vinted.net/t/x/f800/y.jpeg'],
      ['another host', 'https://example.com/y.jpeg'],
      ['a 100x100 thumbnail', 'https://images1.vinted.net/t/x/100x100/y.jpeg'],
      ['an empty address', ''],
    ])('answers 400 `invalid_photo` for %s', async (_n, photoUrl) => {
      const t = setup();
      const ann = await person(t, 'ann@example.com');
      const response = await review(t, ann, reviewInput({ photoUrl }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_photo' });
      expect(t.google.fetched).toHaveLength(0);
      expect(reviewsCounted(t, ann)).toBe(0);
    });

    it('answers 401 without a valid token', async () => {
      const t = setup();
      const response = await post(t.app, '/v1/review', { input: reviewInput() });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    });
  });
});

describe('what the responses and the log never hold', () => {
  it('shows no key, no token and no stack trace in any answer, in any outcome', async () => {
    const t = setup();
    const ann = await person(t, 'ann@example.com');
    const bob = await person(t, 'bob@example.com', { trial_left: 0 });
    const log = captureErrors();
    const bodies: string[] = [];
    const collect = async (response: Response) => {
      bodies.push(await response.text());
      return response;
    };

    await collect(await search(t, ann));
    await collect(await review(t, ann));
    await collect(await search(t, bob));
    await collect(await search(t, ann, 'http://example.com/a.jpg'));
    await collect(await review(t, ann, { nope: true }));
    await collect(await post(t.app, '/v1/search', { photoUrl: PHOTO }));

    t.google.detect = async () => ({ ok: false, reason: 'invalid', refundable: true });
    await collect(await search(t, ann, OTHER_PHOTO));
    t.google.review = async () => ({ ok: false, reason: 'billing', refundable: true });
    await collect(await review(t, ann, reviewInput({ price: '99,00 €' })));
    t.google.detect = async () => {
      throw new Error(`secret failure with ${VISION_KEY}`);
    };
    await collect(await search(t, ann, 'https://images1.vinted.net/t/z/f800/q.jpeg'));

    expect(bodies.length).toBeGreaterThan(8);
    for (const body of bodies) {
      for (const secret of [
        VISION_KEY,
        GEMINI_KEY,
        ann.token,
        bob.token,
        'AIza',
        ' at ',
        'Error:',
      ]) {
        expect(body).not.toContain(secret);
      }
    }
    // The log neither: no address, no token, no key, no photo.
    const logged = JSON.stringify(log.mock.calls);
    for (const secret of [ann.email, bob.email, ann.token, GEMINI_KEY, VISION_KEY, 'vinted.net']) {
      expect(logged).not.toContain(secret);
    }
  });
});
