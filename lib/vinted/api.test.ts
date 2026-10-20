import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  MAX_QUEUE_WAIT_MS,
  MIN_REQUEST_SPACING_MS,
  RequestQueue,
  SELLER_CACHE_KEY_PREFIX,
  SELLER_CACHE_MAX_ENTRIES,
  SLOT_JITTER_MAX_MS,
  SELLER_CACHE_TTL_MS,
  VintedApiError,
  fetchSeller,
  sellerCacheKey,
  storageSpacingStore,
  type ApiDeps,
  type Clock,
} from './api';

// All ids, logins and URLs are made up.
const USER_BODY = {
  code: 0,
  user: {
    id: 7000001,
    login: 'vendeuse_test',
    feedback_count: 40,
    feedback_reputation: 0.9,
    item_count: 29,
    total_items_count: 262,
  },
};

const wardrobeItem = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Robe ${id}`,
  price: { amount: '12.5', currency_code: 'EUR' },
  status: 'Neuf avec étiquette',
  size: 'M',
  photos: [
    { id: 1, is_main: false, url: `https://images1.vinted.net/t/${id}b/f800/b.webp?s=b` },
    { id: 2, is_main: true, url: `https://images1.vinted.net/t/${id}a/f800/a.webp?s=a` },
  ],
  ...overrides,
});

const WARDROBE_BODY = {
  code: 0,
  items: [
    wardrobeItem(1),
    wardrobeItem(2, { status: 'Très bon état', size: '', photos: [] }),
    wardrobeItem(3, { is_closed: true }),
    wardrobeItem(4, { price: 8, currency: 'PLN', status_id: 3, status: 'whatever' }),
    { id: 5, title: 'sans prix' },
  ],
  pagination: { total_entries: 117 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A clock whose sleep advances time instantly, recording every wait. */
function fakeClock(): Clock & { time: number; waits: number[] } {
  const clock = {
    time: 1_000_000,
    waits: [] as number[],
    now: () => clock.time,
    sleep: (ms: number) => {
      clock.waits.push(ms);
      clock.time += ms;
      return Promise.resolve();
    },
  };
  return clock;
}

interface Harness {
  deps: ApiDeps;
  fetchMock: ReturnType<typeof vi.fn>;
  clock: ReturnType<typeof fakeClock>;
}

function harness(responder: (url: string) => Response | Promise<Response>): Harness {
  const clock = fakeClock();
  const fetchMock = vi.fn((url: string) => Promise.resolve(responder(url)));
  return {
    clock,
    fetchMock,
    deps: {
      fetch: fetchMock as unknown as ApiDeps['fetch'],
      queue: new RequestQueue(MIN_REQUEST_SPACING_MS, clock),
      now: clock.now,
      storage: browser.storage.local,
    },
  };
}

const okResponder = (url: string) =>
  url.includes('/wardrobe/') ? json(WARDROBE_BODY) : json(USER_BODY);

beforeEach(() => {
  fakeBrowser.reset();
});

describe('RequestQueue', () => {
  it('starts tasks one at a time, at least the spacing apart', async () => {
    const clock = fakeClock();
    const queue = new RequestQueue(1_500, clock);
    const starts: number[] = [];
    const task = () => {
      starts.push(clock.now());
      return Promise.resolve();
    };
    await Promise.all([queue.run(task), queue.run(task), queue.run(task)]);
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1_500);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(1_500);
  });

  it('does not wait once the spacing has already elapsed', async () => {
    const clock = fakeClock();
    const queue = new RequestQueue(1_500, clock);
    await queue.run(() => Promise.resolve());
    clock.time += 5_000;
    await queue.run(() => Promise.resolve());
    expect(clock.waits).toEqual([]);
  });

  it('keeps going after a failed task', async () => {
    const queue = new RequestQueue(0, fakeClock());
    await expect(queue.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(queue.run(() => Promise.resolve(42))).resolves.toBe(42);
  });
});

describe('fetchSeller', () => {
  it('calls both endpoints with credentials and the accept header, spaced apart', async () => {
    const { deps, fetchMock, clock } = harness(okResponder);
    await fetchSeller('7000001', deps);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v2/users/7000001');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v2/wardrobe/7000001/items?page=1&per_page=96');
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
    }
    expect(clock.waits).toEqual([MIN_REQUEST_SPACING_MS]);
  });

  it('never calls the blocked item details endpoint', async () => {
    const { deps, fetchMock } = harness(okResponder);
    await fetchSeller('7000001', deps);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/details'))).toBe(false);
  });

  it('maps the profile and the wardrobe to a Seller', async () => {
    const { deps } = harness(okResponder);
    const seller = await fetchSeller('7000001', deps);

    expect(seller).toMatchObject({
      id: '7000001',
      login: 'vendeuse_test',
      createdAt: null,
      feedbackCount: 40,
      rating: 4.5,
      itemCount: 29,
    });
    // Closed and malformed entries are dropped.
    expect(seller.items.map((i) => i.id)).toEqual(['1', '2', '4']);
    expect(seller.items[0]).toEqual({
      id: '1',
      title: 'Robe 1',
      condition: 'new_with_tags',
      size: 'M',
      brand: null,
      price: { amount: 12.5, currency: 'EUR' },
      photoUrl: 'https://images1.vinted.net/t/1a/f800/a.webp?s=a',
    });
    expect(seller.items[1]).toMatchObject({ condition: 'very_good', size: null, photoUrl: null });
    expect(seller.items[2]).toMatchObject({
      condition: 'good',
      price: { amount: 8, currency: 'PLN' },
    });
  });

  it('keeps a missing review count as null instead of zero', async () => {
    const user = { ...USER_BODY.user } as Record<string, unknown>;
    delete user.feedback_count;
    const { deps } = harness((url) =>
      url.includes('/wardrobe/') ? json(WARDROBE_BODY) : json({ user }),
    );
    const seller = await fetchSeller('7000001', deps);
    expect(seller.feedbackCount).toBeNull();
    expect(seller.rating).toBe(4.5);
  });

  it('reads the wardrobe brand as a string or as an object with a title', async () => {
    const body = {
      items: [
        wardrobeItem(1, { brand: 'Zara' }),
        wardrobeItem(2, { brand: { id: 5, title: 'Mango' } }),
        wardrobeItem(3, { brand: '' }),
      ],
    };
    const { deps } = harness((url) => (url.includes('/wardrobe/') ? json(body) : json(USER_BODY)));
    const seller = await fetchSeller('7000001', deps);
    expect(seller.items.map((item) => item.brand)).toEqual(['Zara', 'Mango', null]);
  });

  it('has no rating without any feedback, and falls back on the wardrobe total', async () => {
    const user = { ...USER_BODY.user, feedback_count: 0, feedback_reputation: 0 } as Record<
      string,
      unknown
    >;
    delete user.item_count;
    const { deps } = harness((url) =>
      url.includes('/wardrobe/') ? json(WARDROBE_BODY) : json({ user }),
    );
    const seller = await fetchSeller('7000001', deps);
    expect(seller.rating).toBeNull();
    expect(seller.feedbackCount).toBe(0);
    expect(seller.itemCount).toBe(117);
  });

  it('serves a fresh cached seller without any request', async () => {
    const first = harness(okResponder);
    const seller = await fetchSeller('7000001', first.deps);

    const second = harness(okResponder);
    second.clock.time = first.clock.time + SELLER_CACHE_TTL_MS - 1;
    await expect(fetchSeller('7000001', second.deps)).resolves.toEqual(seller);
    expect(second.fetchMock).not.toHaveBeenCalled();
  });

  it('fetches again once the cache is older than 24 hours', async () => {
    const first = harness(okResponder);
    await fetchSeller('7000001', first.deps);

    const second = harness(okResponder);
    second.clock.time = first.clock.time + SELLER_CACHE_TTL_MS;
    await fetchSeller('7000001', second.deps);
    expect(second.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('prunes expired entries and keeps at most the cap', async () => {
    const { deps, clock } = harness(okResponder);
    const entry = (fetchedAt: number) => ({ fetchedAt, seller: { items: [] } });
    const stored: Record<string, unknown> = {
      [sellerCacheKey('old')]: entry(clock.time - SELLER_CACHE_TTL_MS - 1),
      unrelated: 'keep me',
    };
    for (let i = 0; i < SELLER_CACHE_MAX_ENTRIES; i++) {
      stored[sellerCacheKey(`s${i}`)] = entry(clock.time - 1_000 - i);
    }
    await browser.storage.local.set(stored);

    await fetchSeller('7000001', deps);

    const keys = Object.keys(await browser.storage.local.get(null)).filter((k) =>
      k.startsWith(SELLER_CACHE_KEY_PREFIX),
    );
    expect(keys).toHaveLength(SELLER_CACHE_MAX_ENTRIES);
    expect(keys).toContain(sellerCacheKey('7000001'));
    expect(keys).not.toContain(sellerCacheKey('old'));
    expect(keys).not.toContain(sellerCacheKey(`s${SELLER_CACHE_MAX_ENTRIES - 1}`));
    expect((await browser.storage.local.get('unrelated')).unrelated).toBe('keep me');
  });

  it('still works when the storage is unavailable', async () => {
    const { deps } = harness(okResponder);
    const broken = {
      get: () => Promise.reject(new Error('no storage')),
      set: () => Promise.reject(new Error('no storage')),
      remove: () => Promise.reject(new Error('no storage')),
    };
    const seller = await fetchSeller('7000001', { ...deps, storage: broken as ApiDeps['storage'] });
    expect(seller.login).toBe('vendeuse_test');
  });
});

describe('fetchSeller errors', () => {
  const failWith = async (responder: (url: string) => Response | Promise<Response>) => {
    const { deps } = harness(responder);
    return fetchSeller('7000001', deps).then(
      () => null,
      (error: unknown) => error,
    );
  };

  it.each([
    [403, 'blocked'],
    [429, 'rate_limited'],
    [404, 'not_found'],
    [500, 'http'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    const error = await failWith(() => new Response('<html>nope</html>', { status }));
    expect(error).toBeInstanceOf(VintedApiError);
    expect(error).toMatchObject({ code, status });
  });

  it('maps a rejected request to a network error', async () => {
    const error = await failWith(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(error).toMatchObject({ code: 'network' });
  });

  it('maps a non-JSON body and a wrong shape to invalid_response', async () => {
    expect(await failWith(() => new Response('<html>challenge</html>'))).toMatchObject({
      code: 'invalid_response',
    });
    expect(await failWith(() => json({ code: 0 }))).toMatchObject({ code: 'invalid_response' });
    expect(
      await failWith((url) =>
        url.includes('/wardrobe/') ? json({ items: 'nope' }) : json(USER_BODY),
      ),
    ).toMatchObject({ code: 'invalid_response' });
  });

  it('fails when the wardrobe call fails, and caches nothing', async () => {
    const { deps } = harness((url) =>
      url.includes('/wardrobe/') ? new Response('', { status: 403 }) : json(USER_BODY),
    );
    await expect(fetchSeller('7000001', deps)).rejects.toMatchObject({ code: 'blocked' });
    expect(await browser.storage.local.get(sellerCacheKey('7000001'))).toEqual({});
  });

  it('refuses a malformed id without sending anything', async () => {
    const { deps, fetchMock } = harness(okResponder);
    await expect(fetchSeller('../admin', deps)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('shared request spacing', () => {
  const spacingKey = 'fripon:lastRequestAt:test';
  const store = () =>
    storageSpacingStore(
      {
        get: (key) => browser.storage.local.get(key),
        set: (items) => browser.storage.local.set(items),
      },
      () => spacingKey,
    );

  it('keeps pages and tabs apart through storage', async () => {
    const clock = fakeClock();
    const pageA = new RequestQueue(1_500, clock, store());
    const pageB = new RequestQueue(1_500, clock, store());
    const starts: number[] = [];
    const task = () => {
      starts.push(clock.now());
      return Promise.resolve();
    };

    await pageA.run(task);
    await pageB.run(task);
    await pageA.run(task);

    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1_500);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(1_500);
  });

  it('reserves its slot in storage before it starts', async () => {
    const clock = fakeClock();
    await new RequestQueue(1_500, clock, store()).run(() => Promise.resolve());
    expect((await browser.storage.local.get(spacingKey))[spacingKey]).toBe(clock.time);
  });

  it('still spaces requests within the page when the storage fails', async () => {
    const clock = fakeClock();
    const broken = storageSpacingStore(
      { get: () => Promise.reject(new Error('x')), set: () => Promise.reject(new Error('x')) },
      () => spacingKey,
    );
    const queue = new RequestQueue(1_500, clock, broken, { random: () => 0 });
    await queue.run(() => Promise.resolve());
    await queue.run(() => Promise.resolve());
    expect(clock.waits).toEqual([1_500]);
  });
});

describe('shared slot', () => {
  const key = 'fripon:lastRequestAt:test';
  const store = () =>
    storageSpacingStore(
      {
        get: (k) => browser.storage.local.get(k),
        set: (items) => browser.storage.local.set(items),
      },
      () => key,
    );

  it('adds a random jitter below 300 ms to reserved slots', async () => {
    const clock = fakeClock();
    const start = clock.time;
    const queue = new RequestQueue(1_500, clock, store(), { random: () => 0.5 });
    await queue.run(() => Promise.resolve());
    expect(clock.time - start).toBe(SLOT_JITTER_MAX_MS / 2);

    await browser.storage.local.clear();
    const high = new RequestQueue(1_500, fakeClock(), store(), { random: () => 0.999 });
    await high.run(() => Promise.resolve());
    const stored = (await browser.storage.local.get(key))[key] as number;
    expect(stored - 1_000_000).toBeLessThan(SLOT_JITTER_MAX_MS);
  });

  it('adds no jitter when the queue is not shared', async () => {
    const clock = fakeClock();
    const start = clock.time;
    await new RequestQueue(1_500, clock, undefined, { random: () => 0.9 }).run(() =>
      Promise.resolve(),
    );
    expect(clock.time).toBe(start);
  });

  it('never waits longer than MAX_QUEUE_WAIT_MS, even with a stored time far in the future', async () => {
    const clock = fakeClock();
    await browser.storage.local.set({ [key]: clock.time + 3_600_000 });
    await new RequestQueue(1_500, clock, store(), { random: () => 0 }).run(() => Promise.resolve());
    expect(clock.waits).toEqual([MAX_QUEUE_WAIT_MS]);
  });

  it('does not reserve a slot when the guard refuses the task', async () => {
    const clock = fakeClock();
    const queue = new RequestQueue(1_500, clock, store(), { random: () => 0 });
    const task = vi.fn(() => Promise.resolve('done'));
    await expect(queue.run(task, () => Promise.reject(new Error('cooling down')))).rejects.toThrow(
      'cooling down',
    );
    expect(task).not.toHaveBeenCalled();
    expect(await browser.storage.local.get(key)).toEqual({});
    // The queue is not stuck.
    await expect(queue.run(task)).resolves.toBe('done');
  });

  it('checks the cooldown before taking a slot in fetchSeller', async () => {
    const clock = fakeClock();
    const queue = new RequestQueue(1_500, clock, store(), { random: () => 0 });
    const { deps, fetchMock } = harness(okResponder);
    await browser.storage.local.set({
      'fripon:cooldownUntil:www.vinted.fr': clock.time + 60_000,
    });
    await expect(
      fetchSeller('7000001', { ...deps, queue, now: clock.now, hostname: 'www.vinted.fr' }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await browser.storage.local.get(key)).toEqual({});
  });
});

describe('fetchSeller in-flight dedupe', () => {
  it('shares one fetch between concurrent calls for the same seller and site', async () => {
    const { deps, fetchMock } = harness(okResponder);
    const on = (hostname: string) => ({ ...deps, hostname });
    const [a, b] = await Promise.all([
      fetchSeller('7000001', on('www.vinted.fr')),
      fetchSeller('7000001', on('www.vinted.fr')),
    ]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not share between sites or sellers', async () => {
    const { deps, fetchMock } = harness(okResponder);
    await Promise.all([
      fetchSeller('7000001', { ...deps, hostname: 'www.vinted.fr' }),
      fetchSeller('7000001', { ...deps, hostname: 'www.vinted.de' }),
      fetchSeller('7000002', { ...deps, hostname: 'www.vinted.fr' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('forgets a failed fetch, so the next call tries again', async () => {
    let healthy = false;
    const { deps, fetchMock } = harness((url) =>
      healthy ? okResponder(url) : new Response('', { status: 500 }),
    );
    await expect(fetchSeller('7000001', deps)).rejects.toMatchObject({ code: 'http' });
    healthy = true;
    await expect(fetchSeller('7000001', deps)).resolves.toMatchObject({ login: 'vendeuse_test' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('fetchSeller cache key', () => {
  it('is versioned and scoped to the site', async () => {
    const { deps } = harness(okResponder);
    await fetchSeller('7000001', { ...deps, hostname: 'www.vinted.fr' });

    const keys = Object.keys(await browser.storage.local.get(null));
    expect(keys).toContain('fripon:seller:v2:www.vinted.fr:7000001');
    expect(sellerCacheKey('7000001', 'www.vinted.de')).toBe(
      'fripon:seller:v2:www.vinted.de:7000001',
    );
  });

  it('does not serve a seller cached on another site', async () => {
    const first = harness(okResponder);
    await fetchSeller('7000001', { ...first.deps, hostname: 'www.vinted.fr' });

    const second = harness(okResponder);
    await fetchSeller('7000001', { ...second.deps, hostname: 'www.vinted.de' });
    expect(second.fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchSeller timeout', () => {
  const hangUntilAborted = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

  it('gives every request an abort signal', async () => {
    const { deps, fetchMock } = harness(okResponder);
    await fetchSeller('7000001', deps);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('gives up on a request that never answers, without blocking the queue', async () => {
    const { deps } = harness(okResponder);
    const hanging = { ...deps, fetch: hangUntilAborted as ApiDeps['fetch'], timeoutMs: 20 };
    await expect(fetchSeller('7000001', hanging)).rejects.toMatchObject({ code: 'timeout' });

    // The same queue still serves the next request.
    await expect(fetchSeller('7000001', { ...deps })).resolves.toMatchObject({
      login: 'vendeuse_test',
    });
  });
});

describe('fetchSeller cooldown', () => {
  const refuse =
    (status: number, headers: Record<string, string> = {}) =>
    () =>
      new Response('', { status, headers });
  const cooldownKey = 'fripon:cooldownUntil:www.vinted.fr';
  const onFr = (deps: ApiDeps) => ({ ...deps, hostname: 'www.vinted.fr' });

  it.each([403, 429])(
    'starts a default cooldown after a %i, shared through storage',
    async (status) => {
      const first = harness(refuse(status));
      await expect(fetchSeller('7000001', onFr(first.deps))).rejects.toMatchObject({ status });
      expect((await browser.storage.local.get(cooldownKey))[cooldownKey]).toBe(
        first.clock.time + DEFAULT_COOLDOWN_MS,
      );

      // Another page of the same site: nothing is sent while the cooldown lasts.
      const second = harness(okResponder);
      second.clock.time = first.clock.time + DEFAULT_COOLDOWN_MS - 1;
      await expect(fetchSeller('7000001', onFr(second.deps))).rejects.toMatchObject({
        code: 'rate_limited',
      });
      expect(second.fetchMock).not.toHaveBeenCalled();
    },
  );

  it('resumes once the cooldown is over', async () => {
    const first = harness(refuse(403));
    await fetchSeller('7000001', onFr(first.deps)).catch(() => undefined);

    const second = harness(okResponder);
    second.clock.time = first.clock.time + DEFAULT_COOLDOWN_MS;
    await expect(fetchSeller('7000001', onFr(second.deps))).resolves.toMatchObject({
      login: 'vendeuse_test',
    });
  });

  it('honours Retry-After in seconds and in HTTP date form, capped', async () => {
    const seconds = harness(refuse(429, { 'retry-after': '120' }));
    await fetchSeller('7000001', onFr(seconds.deps)).catch(() => undefined);
    expect((await browser.storage.local.get(cooldownKey))[cooldownKey]).toBe(
      seconds.clock.time + 120_000,
    );

    await fakeBrowser.reset();
    const date = harness(
      refuse(429, { 'retry-after': new Date(1_000_000 + 90_000).toUTCString() }),
    );
    await fetchSeller('7000001', onFr(date.deps)).catch(() => undefined);
    expect((await browser.storage.local.get(cooldownKey))[cooldownKey]).toBe(1_000_000 + 90_000);

    await fakeBrowser.reset();
    const huge = harness(refuse(429, { 'retry-after': String(10 * 365 * 24 * 3_600) }));
    await fetchSeller('7000001', onFr(huge.deps)).catch(() => undefined);
    expect((await browser.storage.local.get(cooldownKey))[cooldownKey]).toBe(
      huge.clock.time + MAX_COOLDOWN_MS,
    );
  });

  it('does not block a seller that is already cached', async () => {
    const warm = harness(okResponder);
    await fetchSeller('7000001', onFr(warm.deps));
    await browser.storage.local.set({ [cooldownKey]: warm.clock.time + 60_000 });

    const later = harness(okResponder);
    later.clock.time = warm.clock.time + 1_000;
    await expect(fetchSeller('7000001', onFr(later.deps))).resolves.toMatchObject({
      login: 'vendeuse_test',
    });
    expect(later.fetchMock).not.toHaveBeenCalled();
  });

  it('is per site', async () => {
    const fr = harness(refuse(403));
    await fetchSeller('7000001', onFr(fr.deps)).catch(() => undefined);

    const de = harness(okResponder);
    await expect(
      fetchSeller('7000001', { ...de.deps, hostname: 'www.vinted.de' }),
    ).resolves.toMatchObject({ login: 'vendeuse_test' });
  });

  it('does not start a cooldown for other errors', async () => {
    const { deps } = harness(refuse(500));
    await fetchSeller('7000001', onFr(deps)).catch(() => undefined);
    expect(await browser.storage.local.get(cooldownKey)).toEqual({});
  });
});
