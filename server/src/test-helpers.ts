import { randomUUID } from 'node:crypto';
import { createApp, type RouteModule } from './app';
import { loadConfig, type Config } from './config';
import { openDb, type Account, type Db } from './db';
import { canonicalEmail } from './email';
import type { Mailer } from './mailer';

/** Shared by the server's tests: an in-memory database, a clock to move, a mailer to read. */

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ NODE_ENV: 'test' }), authSecret: 'test-secret', ...overrides };
}

export interface Clock {
  now(): Date;
  /** The same instant in milliseconds. */
  ms(): number;
  advance(ms: number): void;
  set(iso: string): void;
}

/** 14:00 in Paris on a Tuesday of October 2026 (CEST, UTC+2): no day or month edge nearby. */
export function fakeClock(start = '2026-10-20T12:00:00Z'): Clock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    ms: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (iso) => {
      current = new Date(iso).getTime();
    },
  };
}

export interface FakeMailer extends Mailer {
  sent: { email: string; code: string }[];
  /** The next `sendCode` rejects with this. */
  failWith: Error | null;
}

export function fakeMailer(): FakeMailer {
  const mailer: FakeMailer = {
    sent: [],
    failWith: null,
    async sendCode(email, code) {
      if (mailer.failWith) throw mailer.failWith;
      mailer.sent.push({ email, code });
    },
  };
  return mailer;
}

let counter = 0;

/** An account with the trial untouched; `overrides` sets any column. */
export function insertAccount(db: Db, overrides: Partial<Account> = {}): Account {
  const email = overrides.email ?? `user-${++counter}@example.com`;
  const account: Account = {
    id: randomUUID(),
    email,
    created_at: 0,
    trial_left: 15,
    stripe_customer_id: null,
    subscription_id: null,
    plan: null,
    subscription_status: null,
    period_end: null,
    canonical_email: canonicalEmail(email),
    ...overrides,
  };
  db.prepare(
    `INSERT INTO accounts (id, email, created_at, trial_left, stripe_customer_id, subscription_id,
       plan, subscription_status, period_end, canonical_email)
     VALUES (@id, @email, @created_at, @trial_left, @stripe_customer_id, @subscription_id,
       @plan, @subscription_status, @period_end, @canonical_email)`,
  ).run(account);
  return account;
}

/** An account on a subscription. */
export function insertSubscriber(
  db: Db,
  plan: 'essentiel' | 'revendeur' = 'essentiel',
  overrides: Partial<Account> = {},
): Account {
  return insertAccount(db, {
    plan,
    subscription_status: 'active',
    subscription_id: `sub_${randomUUID()}`,
    ...overrides,
  });
}

export function createTestApp(extraRoutes: RouteModule[] = [], config = testConfig()) {
  const db = openDb(':memory:');
  const mailer = fakeMailer();
  const clock = fakeClock();
  const app = createApp({ db, mailer, config, now: clock.now }, extraRoutes);
  return { app, db, mailer, clock, config };
}

export type TestApp = ReturnType<typeof createTestApp>;

/** Sends a JSON request through the app. */
export function post(app: TestApp['app'], path: string, body: unknown, headers = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Signs `email` in through the real routes and returns the bearer token. */
export async function signIn(t: TestApp, email: string): Promise<string> {
  const before = t.mailer.sent.length;
  await post(t.app, '/v1/auth/code', { email });
  const sent = t.mailer.sent[before];
  if (!sent) throw new Error('No code was sent');
  const response = await post(t.app, '/v1/auth/verify', { email, code: sent.code });
  const { token } = (await response.json()) as { token: string };
  return token;
}
