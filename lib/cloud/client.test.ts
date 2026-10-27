import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_ORIGIN, CLOUD_SLOW_TIMEOUT_MS, CLOUD_TIMEOUT_MS } from './config';
import { createCloudClient, type SessionAccess } from './client';

const ORIGIN = 'https://cloud.test';
const PHOTO = 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa';
const USAGE = {
  kind: 'plan',
  plan: 'essentiel',
  month: { used: 3, cap: 300 },
  day: { used: 1, cap: 40 },
  trialLeft: 15,
};
const REVIEW_INPUT = {
  photoUrl: PHOTO,
  title: 'Robe',
  description: '',
  price: '12,00 €',
  signals: ['Une ligne.'],
  fingerprint: ['image:none'],
};

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type Handler = (input: string, init: RequestInit) => Response | Promise<Response>;

function setup(handler: Handler, token: string | null = 'tok-1') {
  const fetch = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async (...args) =>
    handler(...args),
  );
  const clear = vi.fn<(token: string) => Promise<void>>(() => Promise.resolve());
  const session: SessionAccess = { token: () => Promise.resolve(token), clear };
  const client = createCloudClient({ fetch, session, origin: ORIGIN });
  const call = (index = 0) => {
    const [url, init] = fetch.mock.calls[index] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    return {
      url,
      init,
      headers,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
  };
  return { client, fetch, clear, call };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('talks to the Fripon Cloud origin by default', () => {
  expect(CLOUD_ORIGIN).toMatch(/^https:\/\//);
});

describe('sign-in', () => {
  it('asks for a code with the address, and needs no token', async () => {
    const { client, call } = setup(() => json(204));
    expect(await client.requestCode('a@b.fr')).toEqual({ ok: true });
    const sent = call();
    expect(sent.url).toBe(`${ORIGIN}/v1/auth/code`);
    expect(sent.init.method).toBe('POST');
    expect(sent.init.credentials).toBe('omit');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.body).toEqual({ email: 'a@b.fr' });
  });

  it.each([
    [400, 'invalid_email'],
    [429, 'rate_limited'],
    [503, 'mail_unavailable'],
    [500, 'mail_unavailable'],
    [404, 'mail_unavailable'],
  ])('reads a %i answer to the code request as %s', async (status, reason) => {
    const { client } = setup(() => json(status, { error: 'x' }));
    expect(await client.requestCode('a@b.fr')).toEqual({ ok: false, reason });
  });

  it('reads a network failure as network, never as a throw', async () => {
    const { client } = setup(() => Promise.reject(new TypeError('offline')));
    expect(await client.requestCode('a@b.fr')).toEqual({ ok: false, reason: 'network' });
    expect(await client.verify('a@b.fr', '123456')).toEqual({ ok: false, reason: 'network' });
  });

  it('gives back the token of a right code', async () => {
    const { client, call } = setup(() => json(200, { token: 'tok-9' }));
    expect(await client.verify('a@b.fr', '123456')).toEqual({ ok: true, token: 'tok-9' });
    expect(call().body).toEqual({ email: 'a@b.fr', code: '123456' });
  });

  it.each([
    [400, { error: 'invalid_code' }, 'invalid_code'],
    [429, { error: 'rate_limited' }, 'rate_limited'],
    [500, undefined, 'network'],
    [200, {}, 'network'],
    [200, { token: '' }, 'network'],
  ])('reads %i %j from the verification as %s', async (status, body, reason) => {
    const { client } = setup(() => json(status, body));
    expect(await client.verify('a@b.fr', '000000')).toEqual({ ok: false, reason });
  });

  it('logs out with the given token, whatever the answer', async () => {
    const { client, call } = setup(() => json(500));
    await expect(client.logout('tok-old')).resolves.toBeUndefined();
    expect(call().url).toBe(`${ORIGIN}/v1/auth/logout`);
    expect(call().headers.authorization).toBe('Bearer tok-old');

    const failing = setup(() => Promise.reject(new Error('offline')));
    await expect(failing.client.logout('tok')).resolves.toBeUndefined();
  });
});

describe('the account', () => {
  it('reads /v1/me with the bearer token', async () => {
    const subscription = { status: 'active', periodEnd: 1_800_000_000_000 };
    const { client, call } = setup(() => json(200, { email: 'a@b.fr', ...USAGE, subscription }));
    const answer = await client.me();
    expect(answer).toEqual({ ok: true, me: { email: 'a@b.fr', usage: USAGE, subscription } });
    expect(call().init.method).toBe('GET');
    expect(call().headers.authorization).toBe('Bearer tok-1');
    expect(call().body).toBeUndefined();
  });

  it('is signed out without a token, and sends nothing', async () => {
    const { client, fetch } = setup(() => json(200, {}), null);
    expect(await client.me()).toEqual({ ok: false, reason: 'signed_out' });
    expect(await client.search(PHOTO)).toEqual({ ok: false, reason: 'signed_out' });
    expect(await client.review(REVIEW_INPUT)).toEqual({ ok: false, reason: 'signed_out' });
    expect(await client.checkout('essentiel_monthly')).toEqual({
      ok: false,
      reason: 'signed_out',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('signs the session out on a 401, whatever the call', async () => {
    const calls: [string, () => Promise<unknown>][] = [];
    const { client, clear } = setup(() => json(401, { error: 'unauthorized' }));
    calls.push(['me', () => client.me()]);
    calls.push(['search', () => client.search(PHOTO)]);
    calls.push(['review', () => client.review(REVIEW_INPUT)]);
    calls.push(['checkout', () => client.checkout('revendeur_monthly')]);
    calls.push(['portal', () => client.portal()]);
    for (const [, run] of calls) {
      expect(await run()).toEqual({ ok: false, reason: 'signed_out' });
    }
    expect(clear).toHaveBeenCalledTimes(calls.length);
    expect(clear).toHaveBeenCalledWith('tok-1');
  });

  it('reads an answer it cannot use as network', async () => {
    expect(await setup(() => json(200, { email: 'a@b.fr' })).client.me()).toEqual({
      ok: false,
      reason: 'network',
    });
    expect(await setup(() => json(500)).client.me()).toEqual({ ok: false, reason: 'network' });
    expect(await setup(() => new Response('<html>', { status: 200 })).client.me()).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});

describe('search', () => {
  it('sends the photo address and reads the matches and the usage', async () => {
    const { client, call } = setup(() =>
      json(200, {
        matches: [
          { platform: 'Shein', url: 'https://fr.shein.com/p-1.html', exact: true, price: null },
        ],
        charged: true,
        usage: USAGE,
      }),
    );
    expect(await client.search(PHOTO)).toEqual({
      ok: true,
      matches: [
        { platform: 'Shein', url: 'https://fr.shein.com/p-1.html', exact: true, price: null },
      ],
      charged: true,
      usage: USAGE,
    });
    expect(call().url).toBe(`${ORIGIN}/v1/search`);
    expect(call().body).toEqual({ photoUrl: PHOTO });
    expect(call().headers.authorization).toBe('Bearer tok-1');
  });

  it('keeps only the matches that are safe to link, and never a price', async () => {
    const { client } = setup(() =>
      json(200, {
        matches: [
          { platform: 'Temu', url: 'https://www.temu.com/x.html', exact: false, price: 4 },
          { platform: 'Evil', url: 'javascript:alert(1)', exact: true },
          { platform: 'Shein', url: 'https://fr.shein.com/a', exact: 'yes' },
          'garbage',
        ],
        charged: false,
      }),
    );
    expect(await client.search(PHOTO)).toEqual({
      ok: true,
      matches: [
        { platform: 'Temu', url: 'https://www.temu.com/x.html', exact: false, price: null },
      ],
      charged: false,
      usage: null,
    });
  });

  it('reads an answer without a list of matches as unavailable', async () => {
    const { client } = setup(() => json(200, { charged: false }));
    expect(await client.search(PHOTO)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it.each([
    [400, { error: 'invalid_photo' }, 'photo'],
    [400, { error: 'invalid_request' }, 'unavailable'],
    [402, { error: 'quota', reason: 'day' }, 'quota'],
    [403, { error: 'forbidden' }, 'unavailable'],
    [403, { error: 'not_searched' }, 'unavailable'],
    [429, { error: 'rate_limited' }, 'rate_limited'],
    [502, { error: 'upstream', reason: 'timeout' }, 'unavailable'],
    [503, { error: 'capacity' }, 'unavailable'],
    [500, undefined, 'network'],
  ])('reads %i %j as %s', async (status, body, reason) => {
    const { client } = setup(() => json(status, body));
    expect(await client.search(PHOTO)).toEqual({ ok: false, reason });
  });
});

describe('review', () => {
  it('sends the input and reads the review', async () => {
    const { client, call } = setup(() =>
      json(200, { review: { catalogPhoto: true, summary: 'Photo de catalogue.' } }),
    );
    expect(await client.review(REVIEW_INPUT)).toEqual({
      ok: true,
      review: { catalogPhoto: true, summary: 'Photo de catalogue.' },
    });
    expect(call().url).toBe(`${ORIGIN}/v1/review`);
    expect(call().body).toEqual({ input: REVIEW_INPUT });
  });

  it('refuses a review that does not pass the same checks as Gemini’s own answer', async () => {
    for (const review of [
      { catalogPhoto: 'yes', summary: 'x' },
      { catalogPhoto: true, summary: '' },
      { catalogPhoto: true, summary: 'x'.repeat(601) },
      null,
    ]) {
      const { client } = setup(() => json(200, { review }));
      expect(await client.review(REVIEW_INPUT)).toEqual({
        ok: false,
        reason: 'invalid_answer',
      });
    }
  });

  it('strips the HTML a review could carry, like the local one', async () => {
    const { client } = setup(() =>
      json(200, { review: { catalogPhoto: false, summary: 'Rien <b>de grave</b> ici.' } }),
    );
    const answer = await client.review(REVIEW_INPUT);
    expect(answer.ok && answer.review.summary).not.toContain('<');
    expect(answer.ok && answer.review.summary).toContain('de grave');
  });

  it.each([
    [400, { error: 'invalid_photo' }, 'photo'],
    [403, { error: 'not_searched' }, 'not_searched'],
    [429, { error: 'rate_limited' }, 'rate_limited'],
    [502, { error: 'upstream' }, 'unavailable'],
    [503, { error: 'capacity' }, 'unavailable'],
  ])('reads %i %j as %s', async (status, body, reason) => {
    const { client } = setup(() => json(status, body));
    expect(await client.review(REVIEW_INPUT)).toEqual({ ok: false, reason });
  });
});

describe('billing', () => {
  it('asks for a Checkout page of the chosen price and gives back its address', async () => {
    const { client, call } = setup(() => json(200, { url: 'https://checkout.stripe.com/c/pay/x' }));
    expect(await client.checkout('essentiel_yearly')).toEqual({
      ok: true,
      url: 'https://checkout.stripe.com/c/pay/x',
    });
    expect(call().url).toBe(`${ORIGIN}/v1/billing/checkout`);
    expect(call().body).toEqual({ price: 'essentiel_yearly' });
  });

  it('asks for the customer portal', async () => {
    const { client, call } = setup(() =>
      json(200, { url: 'https://billing.stripe.com/p/session/x' }),
    );
    expect(await client.portal()).toEqual({
      ok: true,
      url: 'https://billing.stripe.com/p/session/x',
    });
    expect(call().url).toBe(`${ORIGIN}/v1/billing/portal`);
  });

  it('only hands back an https address', async () => {
    for (const url of ['http://checkout.stripe.com/x', 'javascript:alert(1)', 'not a url', 5]) {
      const { client } = setup(() => json(200, { url }));
      expect(await client.checkout('essentiel_monthly')).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    }
  });

  it.each([
    [409, { error: 'no_customer' }, 'no_customer'],
    [429, { error: 'rate_limited' }, 'rate_limited'],
    [500, undefined, 'unavailable'],
  ])('reads %i %j as %s', async (status, body, reason) => {
    const { client } = setup(() => json(status, body));
    expect(await client.portal()).toEqual({ ok: false, reason });
  });

  it('reads no answer at all as network', async () => {
    const { client } = setup(() => Promise.reject(new Error('offline')));
    expect(await client.portal()).toEqual({ ok: false, reason: 'network' });
  });
});

describe('timeouts', () => {
  it('gives the search and the review longer than everything else, body included', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { client } = setup(() => json(200, {}));
    await client.me();
    await client.search(PHOTO);
    await client.review(REVIEW_INPUT);
    await client.requestCode('a@b.fr');
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([
      CLOUD_TIMEOUT_MS,
      CLOUD_SLOW_TIMEOUT_MS,
      CLOUD_SLOW_TIMEOUT_MS,
      CLOUD_TIMEOUT_MS,
    ]);
    expect(CLOUD_SLOW_TIMEOUT_MS).toBe(45_000);
    expect(CLOUD_TIMEOUT_MS).toBe(10_000);
  });

  it('waits longer than the server does in the worst case, so a charged analysis is never an error', () => {
    // Server: photo download 10 s, then Vision 20 s or Gemini 30 s.
    const worstCase = 10_000 + 30_000;
    expect(CLOUD_SLOW_TIMEOUT_MS).toBeGreaterThan(worstCase);
  });

  it('reads an aborted request as network', async () => {
    const { client } = setup(() =>
      Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    expect(await client.search(PHOTO)).toEqual({ ok: false, reason: 'network' });
  });

  it('reads an answer whose body never ends as network', async () => {
    const { client } = setup(() => {
      const response = json(200, {});
      vi.spyOn(response, 'json').mockRejectedValue(new DOMException('aborted', 'AbortError'));
      return response;
    });
    // An unreadable body is still an answer: it is the answer that is not usable.
    expect(await client.me()).toEqual({ ok: false, reason: 'network' });
  });
});
