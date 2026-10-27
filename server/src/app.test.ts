import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteModule } from './app';
import { API_REQUESTS_PER_MINUTE } from './context';
import { MAX_BODY_BYTES } from './http';
import { reserveAnalysis } from './quota';
import { CODE_REQUESTS_PER_HOUR, VERIFY_ATTEMPTS_PER_HOUR } from './routes/auth';
import { createTestApp, insertAccount, post, signIn, testConfig } from './test-helpers';

const EMAIL = 'sam@example.com';
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const wrongCode = (code: string) => (code === '000000' ? '000001' : '000000');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /healthz', () => {
  it('answers ok while the database answers', async () => {
    const t = createTestApp();
    const response = await t.app.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers 503 when it does not', async () => {
    const t = createTestApp();
    t.db.close();
    const response = await t.app.request('/healthz');
    expect(response.status).toBe(503);
  });
});

describe('POST /v1/auth/code', () => {
  it('answers 204 and mails the code', async () => {
    const t = createTestApp();
    const response = await post(t.app, '/v1/auth/code', { email: ` ${EMAIL.toUpperCase()} ` });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(t.mailer.sent).toEqual([{ email: EMAIL, code: expect.stringMatching(/^\d{6}$/) }]);
  });

  it('answers the same 204 whether the address has an account, is throttled, or not', async () => {
    const t = createTestApp();
    await signIn(t, EMAIL); // the account exists now
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await post(t.app, '/v1/auth/code', { email: EMAIL })).status);
    }
    statuses.push((await post(t.app, '/v1/auth/code', { email: 'new@example.com' })).status);
    expect(statuses).toEqual([204, 204, 204, 204, 204, 204]);
    // 1 (sign-in) + 3 (the throttle) + 1 (the other address)
    expect(t.mailer.sent).toHaveLength(5);
  });

  it.each([
    ['no email', {}],
    ['a number', { email: 12 }],
    ['not an address', { email: 'nope' }],
    ['an array body', [EMAIL]],
    ['null', null],
  ])('answers 400 for %s', async (_name, body) => {
    const t = createTestApp();
    const response = await post(t.app, '/v1/auth/code', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(t.mailer.sent).toEqual([]);
  });

  it('only reads JSON', async () => {
    const t = createTestApp();
    const base = { method: 'POST', body: JSON.stringify({ email: EMAIL }) };
    expect((await t.app.request('/v1/auth/code', base)).status).toBe(400);
    expect(
      (await t.app.request('/v1/auth/code', { ...base, headers: { 'content-type': 'text/plain' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await t.app.request('/v1/auth/code', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{not json',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.app.request('/v1/auth/code', {
          ...base,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      ).status,
    ).toBe(204);
    expect(t.mailer.sent).toHaveLength(1);
  });

  it('refuses a body above 16 KB with 413', async () => {
    const t = createTestApp();
    const big = JSON.stringify({ email: EMAIL, padding: 'x'.repeat(MAX_BODY_BYTES) });
    const response = await t.app.request('/v1/auth/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
      body: big,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload_too_large' });
    expect(t.mailer.sent).toEqual([]);
  });

  it('answers 503 when the mail cannot be sent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = createTestApp();
    t.mailer.failWith = new Error('smtp down');
    const response = await post(t.app, '/v1/auth/code', { email: EMAIL });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'mail_unavailable' });
  });
});

describe('POST /v1/auth/verify', () => {
  it('signs in with the right code', async () => {
    const t = createTestApp();
    await post(t.app, '/v1/auth/code', { email: EMAIL });
    const response = await post(t.app, '/v1/auth/verify', {
      email: EMAIL,
      code: t.mailer.sent[0]?.code,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  });

  it('answers 400 invalid_code for a wrong, used or expired code, the same each time', async () => {
    const t = createTestApp();
    await post(t.app, '/v1/auth/code', { email: EMAIL });
    const code = t.mailer.sent[0]!.code;

    const wrong = await post(t.app, '/v1/auth/verify', { email: EMAIL, code: wrongCode(code) });
    expect(wrong.status).toBe(400);
    const wrongBody = await wrong.json();
    expect(wrongBody).toEqual({ error: 'invalid_code' });

    await post(t.app, '/v1/auth/verify', { email: EMAIL, code });
    const used = await post(t.app, '/v1/auth/verify', { email: EMAIL, code });
    expect(used.status).toBe(400);
    expect(await used.json()).toEqual(wrongBody);

    await post(t.app, '/v1/auth/code', { email: EMAIL });
    t.clock.advance(11 * 60 * 1000);
    const expired = await post(t.app, '/v1/auth/verify', {
      email: EMAIL,
      code: t.mailer.sent[1]!.code,
    });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual(wrongBody);

    const unknown = await post(t.app, '/v1/auth/verify', {
      email: 'nobody@example.com',
      code: '123456',
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual(wrongBody);
  });

  it('locks a code after 5 wrong tries', async () => {
    const t = createTestApp();
    await post(t.app, '/v1/auth/code', { email: EMAIL });
    const code = t.mailer.sent[0]!.code;
    for (let i = 0; i < 5; i++) {
      await post(t.app, '/v1/auth/verify', { email: EMAIL, code: wrongCode(code) });
    }
    const response = await post(t.app, '/v1/auth/verify', { email: EMAIL, code });
    expect(response.status).toBe(400);
  });

  it('locks the address after 10 wrong tries over several codes, and answers the same invalid_code', async () => {
    const t = createTestApp();
    const wrongBody = { error: 'invalid_code' };
    for (let round = 0; round < 2; round++) {
      await post(t.app, '/v1/auth/code', { email: EMAIL });
      const code = t.mailer.sent.at(-1)!.code;
      for (let i = 0; i < 5; i++) {
        await post(t.app, '/v1/auth/verify', { email: EMAIL, code: wrongCode(code) });
      }
    }
    await post(t.app, '/v1/auth/code', { email: EMAIL });
    const fresh = t.mailer.sent.at(-1)!.code;

    const locked = await post(t.app, '/v1/auth/verify', { email: EMAIL, code: fresh });
    const wrong = await post(t.app, '/v1/auth/verify', { email: EMAIL, code: wrongCode(fresh) });

    // The right code and a wrong one are told apart by nothing.
    expect(locked.status).toBe(400);
    expect(await locked.json()).toEqual(wrongBody);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual(wrongBody);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });

    // A day later the address can sign in again.
    t.clock.advance(24 * 60 * 60 * 1000);
    await post(t.app, '/v1/auth/code', { email: EMAIL });
    const later = await post(t.app, '/v1/auth/verify', {
      email: EMAIL,
      code: t.mailer.sent.at(-1)!.code,
    });
    expect(later.status).toBe(200);
  });

  it('starts a 4th account created from the same client address without a trial, and signs it in', async () => {
    const t = createTestApp([], testConfig({ trustProxy: true }));
    const signInFrom = async (email: string, ip: string) => {
      await post(t.app, '/v1/auth/code', { email }, { 'x-forwarded-for': ip });
      const response = await post(
        t.app,
        '/v1/auth/verify',
        { email, code: t.mailer.sent.at(-1)!.code },
        { 'x-forwarded-for': ip },
      );
      expect(response.status).toBe(200);
      const { token } = (await response.json()) as { token: string };
      return (await (await t.app.request('/v1/me', { headers: bearer(token) })).json()) as {
        trialLeft: number;
      };
    };

    for (let i = 1; i <= 3; i++) {
      expect((await signInFrom(`n${i}@example.com`, '203.0.113.50')).trialLeft).toBe(15);
    }
    expect((await signInFrom('n4@example.com', '203.0.113.50')).trialLeft).toBe(0);
    expect((await signInFrom('n5@example.com', '203.0.113.51')).trialLeft).toBe(15);
    // The same mailbox under another address, from a fresh client address: no trial either.
    expect((await signInFrom('n1+again@example.com', '203.0.113.52')).trialLeft).toBe(0);
  });

  it.each([
    ['no code', { email: EMAIL }],
    ['a numeric code', { email: EMAIL, code: 123456 }],
    ['no email', { code: '123456' }],
    ['a bad email', { email: 'nope', code: '123456' }],
  ])('answers 400 invalid_request for %s', async (_name, body) => {
    const t = createTestApp();
    const response = await post(t.app, '/v1/auth/verify', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });
});

describe('GET /v1/me', () => {
  it('answers 401 without a valid token', async () => {
    const t = createTestApp();
    for (const headers of [
      {},
      { authorization: 'Bearer ' },
      { authorization: 'Bearer nope' },
      { authorization: `Bearer ${'A'.repeat(43)}` },
      { authorization: 'Basic abc' },
      { authorization: 'abc' },
    ]) {
      const response = await t.app.request('/v1/me', { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('shows a new account on its trial', async () => {
    const t = createTestApp();
    const token = await signIn(t, EMAIL);
    const response = await t.app.request('/v1/me', { headers: bearer(token) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      email: EMAIL,
      kind: 'trial',
      month: { used: 0, cap: null },
      day: { used: 0, cap: null },
      trialLeft: 15,
      subscription: null,
    });
  });

  it('shows the trial going down', async () => {
    const t = createTestApp();
    const token = await signIn(t, EMAIL);
    const { id } = t.db.prepare('SELECT id FROM accounts').get() as { id: string };
    reserveAnalysis(t.db, id, 'photo-1', t.clock.now());
    const body = await (await t.app.request('/v1/me', { headers: bearer(token) })).json();
    expect(body).toMatchObject({ kind: 'trial', trialLeft: 14, month: { used: 1 } });
  });

  it('shows the plan, what is left, and the subscription', async () => {
    const t = createTestApp();
    const token = await signIn(t, EMAIL);
    t.db
      .prepare(
        "UPDATE accounts SET plan = 'revendeur', subscription_status = 'active', period_end = 1795000000000",
      )
      .run();
    const response = await t.app.request('/v1/me', { headers: bearer(token) });
    expect(await response.json()).toEqual({
      email: EMAIL,
      kind: 'plan',
      plan: 'revendeur',
      month: { used: 0, cap: 1000 },
      day: { used: 0, cap: 100 },
      trialLeft: 15,
      subscription: { status: 'active', periodEnd: 1795000000000 },
    });
  });

  it('never sends the cache or any other account data', async () => {
    const t = createTestApp();
    const token = await signIn(t, EMAIL);
    insertAccount(t.db, { email: 'other@example.com', stripe_customer_id: 'cus_other' });
    t.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_mine' WHERE email = ?").run(EMAIL);
    const text = await (await t.app.request('/v1/me', { headers: bearer(token) })).text();
    expect(text).not.toContain('cus_');
    expect(text).not.toContain('other@example.com');
  });

  it('is not cached', async () => {
    const t = createTestApp();
    const token = await signIn(t, EMAIL);
    const response = await t.app.request('/v1/me', { headers: bearer(token) });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await t.app.request('/v1/me')).headers.get('cache-control')).toBe('no-store');
  });

  it('sets no CORS headers', async () => {
    const t = createTestApp();
    const token = await signIn(t, EMAIL);
    const response = await t.app.request('/v1/me', {
      headers: { ...bearer(token), origin: 'https://evil.example' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await t.app.request('/v1/auth/code', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST /v1/auth/logout', () => {
  it('ends the session', async () => {
    const t = createTestApp();
    const token = await signIn(t, EMAIL);
    const response = await t.app.request('/v1/auth/logout', {
      method: 'POST',
      headers: bearer(token),
    });
    expect(response.status).toBe(204);
    expect((await t.app.request('/v1/me', { headers: bearer(token) })).status).toBe(401);
  });

  it('answers 401 without a token, and 204 for a token already gone', async () => {
    const t = createTestApp();
    expect((await t.app.request('/v1/auth/logout', { method: 'POST' })).status).toBe(401);
    const gone = await t.app.request('/v1/auth/logout', {
      method: 'POST',
      headers: bearer('A'.repeat(43)),
    });
    expect(gone.status).toBe(204);
  });
});

describe('sessions through the routes', () => {
  it('signs the oldest of 3 browsers out at the 4th sign-in', async () => {
    const t = createTestApp();
    const tokens: string[] = [];
    for (let i = 0; i < 4; i++) tokens.push(await signIn(t, EMAIL));
    const status = async (token: string) =>
      (await t.app.request('/v1/me', { headers: bearer(token) })).status;
    expect(await status(tokens[0]!)).toBe(401);
    for (const token of tokens.slice(1)) expect(await status(token)).toBe(200);
  });
});

describe('rate limits', () => {
  const proxied = () => createTestApp([], testConfig({ trustProxy: true }));
  const ask = (t: ReturnType<typeof createTestApp>, ip: string, email = EMAIL) =>
    post(t.app, '/v1/auth/code', { email }, { 'x-forwarded-for': ip });

  it('limits code requests per client address, with Retry-After', async () => {
    const t = proxied();
    for (let i = 0; i < CODE_REQUESTS_PER_HOUR; i++) {
      expect((await ask(t, '203.0.113.7', `u${i}@example.com`)).status).toBe(204);
    }
    const refused = await ask(t, '203.0.113.7', 'another@example.com');
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'rate_limited' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);

    // Another address is not affected, and the hour gives the first one back.
    expect((await ask(t, '203.0.113.8', 'another@example.com')).status).toBe(204);
    t.clock.advance(60 * 60 * 1000);
    expect((await ask(t, '203.0.113.7', 'another@example.com')).status).toBe(204);
  });

  it('limits code guesses per client address', async () => {
    const t = proxied();
    const verify = (ip: string) =>
      post(t.app, '/v1/auth/verify', { email: EMAIL, code: '123456' }, { 'x-forwarded-for': ip });
    for (let i = 0; i < VERIFY_ATTEMPTS_PER_HOUR; i++)
      expect((await verify('198.51.100.1')).status).toBe(400);
    expect((await verify('198.51.100.1')).status).toBe(429);
    expect((await verify('198.51.100.2')).status).toBe(400);
  });

  it("reads the last X-Forwarded-For entry (the proxy's), not what the client wrote first", async () => {
    const t = proxied();
    for (let i = 0; i < CODE_REQUESTS_PER_HOUR; i++) {
      await ask(t, `10.0.0.${i}, 203.0.113.9`, `u${i}@example.com`);
    }
    // Same real address, a different forged first entry: still refused.
    expect((await ask(t, '10.9.9.9, 203.0.113.9', 'z@example.com')).status).toBe(429);
  });

  it('ignores X-Forwarded-For when the proxy is not trusted', async () => {
    const t = createTestApp([], testConfig({ trustProxy: false }));
    for (let i = 0; i < CODE_REQUESTS_PER_HOUR; i++) {
      await ask(t, `10.0.0.${i}`, `u${i}@example.com`);
    }
    // Rotating the header does not escape the limit: every call is the same socket here.
    expect((await ask(t, '10.1.1.1', 'z@example.com')).status).toBe(429);
  });

  it('limits an account to 60 requests a minute', async () => {
    const t = createTestApp();
    const token = await signIn(t, EMAIL);
    for (let i = 0; i < API_REQUESTS_PER_MINUTE; i++) {
      expect((await t.app.request('/v1/me', { headers: bearer(token) })).status).toBe(200);
    }
    const refused = await t.app.request('/v1/me', { headers: bearer(token) });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();

    // Another account is not affected; a minute later this one is back.
    const other = await signIn(t, 'other@example.com');
    expect((await t.app.request('/v1/me', { headers: bearer(other) })).status).toBe(200);
    t.clock.advance(60_000);
    expect((await t.app.request('/v1/me', { headers: bearer(token) })).status).toBe(200);
  });

  it('does not count requests with a bad token against any account', async () => {
    const t = createTestApp();
    const token = await signIn(t, EMAIL);
    for (let i = 0; i < 100; i++)
      await t.app.request('/v1/me', { headers: bearer('A'.repeat(43)) });
    expect((await t.app.request('/v1/me', { headers: bearer(token) })).status).toBe(200);
  });
});

describe('extension points', () => {
  it('lets another route module use the account middleware', async () => {
    const proxyRoutes: RouteModule = (app, ctx) => {
      app.get('/v1/whoami', ctx.requireAccount, (c) => c.json({ id: c.get('account').id }));
    };
    const t = createTestApp([proxyRoutes]);
    const token = await signIn(t, EMAIL);

    expect((await t.app.request('/v1/whoami')).status).toBe(401);
    const response = await t.app.request('/v1/whoami', { headers: bearer(token) });
    expect(response.status).toBe(200);
    const { id } = t.db.prepare('SELECT id FROM accounts').get() as { id: string };
    expect(await response.json()).toEqual({ id });
    // And it comes with the shared headers.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers unknown routes with JSON 404 and failures with JSON 500', async () => {
    const boom: RouteModule = (app) => {
      app.get('/v1/boom', () => {
        throw new Error('secret detail');
      });
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = createTestApp([boom]);
    const missing = await t.app.request('/nope');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });

    const failed = await t.app.request('/v1/boom');
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'internal' });
  });
});
