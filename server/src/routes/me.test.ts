import { describe, expect, it, vi } from 'vitest';
import type { RouteModule } from '../context';
import type { Account } from '../db';
import { createTestApp, insertAccount, post, signIn, type TestApp } from '../test-helpers';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const count = (t: TestApp, table: string, where = '1 = 1', ...params: unknown[]) =>
  (
    t.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as {
      n: number;
    }
  ).n;

/** Signs `email` in through the real routes, then sets columns of its account. */
async function signedIn(t: TestApp, email: string, patch: Partial<Account> = {}) {
  const token = await signIn(t, email);
  const { id } = t.db.prepare('SELECT id FROM accounts WHERE email = ?').get(email) as {
    id: string;
  };
  for (const [column, value] of Object.entries(patch)) {
    t.db.prepare(`UPDATE accounts SET ${column} = ? WHERE id = ?`).run(value, id);
  }
  return { token, id };
}

/** Plugs a refresher in the way the billing routes do. */
const withRefresher = (refresh: (account: Account) => Promise<Account>): RouteModule => {
  return (_app, ctx) => {
    ctx.subscriptions.refresh = refresh;
  };
};

describe('DELETE /v1/account', () => {
  it('deletes the account and everything that belongs to it, and answers 204', async () => {
    const t = createTestApp();
    const ann = await signedIn(t, 'ann@example.com');
    const bob = await signedIn(t, 'bob@example.com');
    for (const who of [ann, bob]) {
      t.db
        .prepare(
          "INSERT INTO usage (account_id, photo_key, month, day, kind, served_at) VALUES (?, 'p', '2026-10', '2026-10-20', 'plan', 0)",
        )
        .run(who.id);
      t.db
        .prepare(
          "INSERT INTO reviews (account_id, photo_key, month, count, last_at) VALUES (?, 'p', '2026-10', 1, 0)",
        )
        .run(who.id);
    }
    // Rows keyed by the e-mail address, not by the account id.
    t.db
      .prepare('INSERT INTO login_failures (email, ip_hash, at) VALUES (?, ?, ?)')
      .run('ann@example.com', 'h', t.clock.ms());
    t.db
      .prepare('INSERT INTO login_failures (email, ip_hash, at) VALUES (?, ?, ?)')
      .run('bob@example.com', 'h', t.clock.ms());
    await post(t.app, '/v1/auth/code', { email: 'ann@example.com' });
    expect(count(t, 'login_codes', 'email = ?', 'ann@example.com')).toBe(1);

    const response = await t.app.request('/v1/account', {
      method: 'DELETE',
      headers: bearer(ann.token),
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(count(t, 'accounts', 'id = ?', ann.id)).toBe(0);
    for (const table of ['sessions', 'usage', 'reviews']) {
      expect(count(t, table, 'account_id = ?', ann.id)).toBe(0);
    }
    expect(count(t, 'login_codes', 'email = ?', 'ann@example.com')).toBe(0);
    expect(count(t, 'login_failures', 'email = ?', 'ann@example.com')).toBe(0);
    // The token is dead, and the other account is untouched.
    expect((await t.app.request('/v1/me', { headers: bearer(ann.token) })).status).toBe(401);
    expect((await t.app.request('/v1/me', { headers: bearer(bob.token) })).status).toBe(200);
    for (const table of ['sessions', 'usage', 'reviews']) {
      expect(count(t, table, 'account_id = ?', bob.id)).toBe(1);
    }
    expect(count(t, 'login_failures', 'email = ?', 'bob@example.com')).toBe(1);
  });

  it('forgets the Stripe customer with the account (it stays at Stripe, invoices must be kept)', async () => {
    const t = createTestApp();
    const ann = await signedIn(t, 'ann@example.com', { stripe_customer_id: 'cus_ann' });

    expect(
      (await t.app.request('/v1/account', { method: 'DELETE', headers: bearer(ann.token) })).status,
    ).toBe(204);

    expect(count(t, 'accounts', 'stripe_customer_id = ?', 'cus_ann')).toBe(0);
    // The address can sign in again later, as a new account on a new customer.
    const again = await signedIn(t, 'ann@example.com');
    expect(
      t.db.prepare('SELECT stripe_customer_id FROM accounts WHERE id = ?').get(again.id),
    ).toEqual({ stripe_customer_id: null });
  });

  it.each(['active', 'trialing', 'past_due'])(
    'answers 409 active_subscription while the subscription is %s, and deletes nothing',
    async (status) => {
      const t = createTestApp();
      const ann = await signedIn(t, 'ann@example.com', {
        plan: 'essentiel',
        subscription_id: 'sub_1',
        subscription_status: status,
      });

      const response = await t.app.request('/v1/account', {
        method: 'DELETE',
        headers: bearer(ann.token),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'active_subscription' });
      expect(count(t, 'accounts', 'id = ?', ann.id)).toBe(1);
      expect(count(t, 'sessions', 'account_id = ?', ann.id)).toBe(1);
    },
  );

  it.each(['canceled', 'unpaid', 'incomplete_expired', null])(
    'deletes an account whose subscription is %s',
    async (status) => {
      const t = createTestApp();
      const ann = await signedIn(t, 'ann@example.com', {
        plan: 'essentiel',
        subscription_id: 'sub_1',
        subscription_status: status,
      });

      expect(
        (await t.app.request('/v1/account', { method: 'DELETE', headers: bearer(ann.token) }))
          .status,
      ).toBe(204);
      expect(count(t, 'accounts', 'id = ?', ann.id)).toBe(0);
    },
  );

  it('asks Stripe again first when the row looks stale: a subscription that ended no longer blocks', async () => {
    const refresh = vi.fn(async (account: Account) => ({
      ...account,
      subscription_status: 'canceled',
    }));
    const t = createTestApp([withRefresher(refresh)]);
    const ann = await signedIn(t, 'ann@example.com', {
      plan: 'essentiel',
      subscription_id: 'sub_1',
      subscription_status: 'active',
    });

    const response = await t.app.request('/v1/account', {
      method: 'DELETE',
      headers: bearer(ann.token),
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(204);
    expect(count(t, 'accounts', 'id = ?', ann.id)).toBe(0);
  });

  it('answers 401 without a valid token, and touches nothing', async () => {
    const t = createTestApp();
    const ann = insertAccount(t.db, { email: 'ann@example.com' });

    expect((await t.app.request('/v1/account', { method: 'DELETE' })).status).toBe(401);
    expect(
      (await t.app.request('/v1/account', { method: 'DELETE', headers: bearer('x'.repeat(40)) }))
        .status,
    ).toBe(401);
    expect(count(t, 'accounts', 'id = ?', ann.id)).toBe(1);
  });

  it('is not a GET or a POST: only DELETE deletes', async () => {
    const t = createTestApp();
    const ann = await signedIn(t, 'ann@example.com');
    expect(
      (await t.app.request('/v1/account', { method: 'GET', headers: bearer(ann.token) })).status,
    ).toBe(404);
    expect(count(t, 'accounts', 'id = ?', ann.id)).toBe(1);
  });
});

describe('GET /v1/me asks for a fresh subscription first', () => {
  it('answers from the account the refresher returns', async () => {
    const refresh = vi.fn(async (account: Account) => ({
      ...account,
      plan: 'revendeur',
      subscription_status: 'active',
      period_end: 1_795_176_000_000,
    }));
    const t = createTestApp([withRefresher(refresh)]);
    const ann = await signedIn(t, 'ann@example.com', {
      plan: 'essentiel',
      subscription_id: 'sub_1',
      subscription_status: 'canceled',
      period_end: 1,
    });

    const body = (await (await t.app.request('/v1/me', { headers: bearer(ann.token) })).json()) as {
      kind: string;
      plan: string;
      subscription: unknown;
    };

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      kind: 'plan',
      plan: 'revendeur',
      subscription: { status: 'active', periodEnd: 1_795_176_000_000 },
    });
  });

  it('answers with the stored account when there is no Stripe behind (no refresher plugged in)', async () => {
    const t = createTestApp();
    const ann = await signedIn(t, 'ann@example.com');
    const response = await t.app.request('/v1/me', { headers: bearer(ann.token) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: 'ann@example.com', subscription: null });
  });
});
