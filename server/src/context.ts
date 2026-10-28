import type { Context, Hono, MiddlewareHandler } from 'hono';
import { createAlerts, type Alert } from './alerts';
import { createAuth, type Auth } from './auth';
import type { Config } from './config';
import type { Account, Db } from './db';
import { createHealth, type Health } from './health';
import { bearerToken, clientIp, tooManyRequests } from './http';
import type { Mailer } from './mailer';
import { createRateLimiter } from './rate-limit';

/** What `createApp` needs from the outside; tests pass an in-memory db, a fake mailer and clock. */
export interface AppDeps {
  db: Db;
  mailer: Mailer;
  config: Config;
  now: () => Date;
}

/** What the middleware puts on the request for the handlers behind it. */
export interface AppEnv {
  Variables: { account: Account };
}

/** Per account and per minute, on every route behind `requireAccount`. */
export const API_REQUESTS_PER_MINUTE = 60;

/**
 * Where the billing routes plug in what they know of Stripe, for the routes that read an account's
 * plan (`/v1/me`, `/v1/search`, `DELETE /v1/account`) without owning the Stripe client: the lazy
 * resync of a subscription (see `SubscriptionSync`) and the question "does Stripe still bill this
 * account". Until `registerBillingRoutes` runs (no Stripe: tests, development) it answers with the
 * account as it is, and says nothing is billed.
 */
export interface SubscriptionRefresher {
  refresh(account: Account): Promise<Account>;
  /**
   * Whether Stripe has a subscription for the account's customer that bills it (active, trialing,
   * past_due), whatever the local row says (it only moves when a webhook arrives). A live one the
   * row did not know is stored. An abandoned `incomplete` first payment is not live: it is
   * cancelled, so it cannot be paid after the account. Rejects when Stripe cannot be read: the
   * caller must not decide "no" from that.
   */
  hasLiveSubscription(account: Account): Promise<boolean>;
  /**
   * Expires the open Checkout Sessions of the account's customer, so that none can be paid once
   * the account is gone (a subscription nobody owns). Rejects when Stripe cannot be read or a
   * session cannot be expired.
   */
  closeCheckouts(account: Account): Promise<void>;
}

/** The shared pieces a route module receives. */
export interface AppContext extends AppDeps {
  auth: Auth;
  /** Tells the owner, by e-mail, about something only he can fix (at most one mail per kind per hour). */
  alert: Alert;
  /** What `/healthz` says about the owner's Google keys. */
  health: Health;
  subscriptions: SubscriptionRefresher;
  /**
   * Route middleware for anything that needs a signed-in account: 401 without a valid token,
   * 429 past the per-account limit, otherwise `c.get('account')` is set. Use it as
   * `app.post('/v1/search', ctx.requireAccount, handler)`.
   */
  requireAccount: MiddlewareHandler<AppEnv>;
  /** The caller's address, as the config says to read it (see `clientIp`). */
  ip(c: Context): string;
}

/**
 * A group of routes: a function that adds them to the app. The server's own routes are such
 * modules, and `createApp(deps, [more...])` takes the others (proxy, billing) the same way.
 */
export type RouteModule = (app: Hono<AppEnv>, ctx: AppContext) => void;

export function createContext(deps: AppDeps): AppContext {
  const auth = createAuth({
    db: deps.db,
    mailer: deps.mailer,
    secret: deps.config.authSecret,
    now: deps.now,
  });
  const accountLimiter = createRateLimiter({
    limit: API_REQUESTS_PER_MINUTE,
    windowMs: 60_000,
    now: () => deps.now().getTime(),
  });

  const requireAccount: MiddlewareHandler<AppEnv> = async (c, next) => {
    const token = bearerToken(c);
    const account = token === null ? null : auth.authenticate(token);
    if (!account) return c.json({ error: 'unauthorized' }, 401);

    const hit = accountLimiter.hit(account.id);
    if (!hit.allowed) return tooManyRequests(c, hit.retryAfterSeconds);

    c.set('account', account);
    await next();
  };

  const at = () => deps.now().getTime();
  return {
    ...deps,
    auth,
    alert: createAlerts({ mailer: deps.mailer, ownerEmail: deps.config.ownerEmail, now: at }),
    health: createHealth(at),
    subscriptions: {
      refresh: async (account) => account,
      hasLiveSubscription: async () => false,
      closeCheckouts: async () => undefined,
    },
    requireAccount,
    ip: (c) => clientIp(c, deps.config.trustProxy),
  };
}
