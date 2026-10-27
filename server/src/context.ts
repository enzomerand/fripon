import type { Context, Hono, MiddlewareHandler } from 'hono';
import { createAuth, type Auth } from './auth';
import type { Config } from './config';
import type { Account, Db } from './db';
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

/** The shared pieces a route module receives. */
export interface AppContext extends AppDeps {
  auth: Auth;
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

  return {
    ...deps,
    auth,
    requireAccount,
    ip: (c) => clientIp(c, deps.config.trustProxy),
  };
}
