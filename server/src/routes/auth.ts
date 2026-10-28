import { normalizeEmail } from '../auth';
import type { RouteModule } from '../context';
import { UNKNOWN_IP, bearerToken, limitBody, readJsonObject, tooManyRequests } from '../http';
import { createRateLimiter } from '../rate-limit';

const HOUR_MS = 60 * 60 * 1000;
/** Codes asked for, per client address and hour. */
export const CODE_REQUESTS_PER_HOUR = 10;
/** Codes tried, per client address and hour (each code also allows 5 guesses on its own). */
export const VERIFY_ATTEMPTS_PER_HOUR = 30;

/** Sign in by e-mail code: `POST /v1/auth/code`, `/v1/auth/verify`, `/v1/auth/logout`. */
export const registerAuthRoutes: RouteModule = (app, ctx) => {
  const now = () => ctx.now().getTime();
  const codeLimiter = createRateLimiter({
    limit: CODE_REQUESTS_PER_HOUR,
    windowMs: HOUR_MS,
    now,
  });
  const verifyLimiter = createRateLimiter({
    limit: VERIFY_ATTEMPTS_PER_HOUR,
    windowMs: HOUR_MS,
    now,
  });

  // Always 204 for a well-formed request, whether a code was sent (or throttled, or the address
  // has an account): the answer tells nothing about who is registered.
  app.post('/v1/auth/code', limitBody, async (c) => {
    const hit = codeLimiter.hit(ctx.ip(c));
    if (!hit.allowed) return tooManyRequests(c, hit.retryAfterSeconds);

    const email = normalizeEmail((await readJsonObject(c))?.email);
    if (email === null) return c.json({ error: 'invalid_request' }, 400);

    try {
      await ctx.auth.requestCode(email);
    } catch (error) {
      // No address in the log: it is the user's.
      console.error(
        'Could not send a sign-in code:',
        error instanceof Error ? error.message : error,
      );
      return c.json({ error: 'mail_unavailable' }, 503);
    }
    return c.body(null, 204);
  });

  // A wrong, expired, used or locked code all answer the same.
  app.post('/v1/auth/verify', limitBody, async (c) => {
    const hit = verifyLimiter.hit(ctx.ip(c));
    if (!hit.allowed) return tooManyRequests(c, hit.retryAfterSeconds);

    const body = await readJsonObject(c);
    const email = normalizeEmail(body?.email);
    if (email === null || typeof body?.code !== 'string') {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // An address that cannot be told is not counted in the cap on accounts per address.
    const ip = ctx.ip(c);
    const session = ctx.auth.verifyCode(email, body.code, ip === UNKNOWN_IP ? null : ip);
    if (!session) return c.json({ error: 'invalid_code' }, 400);
    return c.json({ token: session.token });
  });

  app.post('/v1/auth/logout', (c) => {
    const token = bearerToken(c);
    if (token === null) return c.json({ error: 'unauthorized' }, 401);
    ctx.auth.logout(token);
    return c.body(null, 204);
  });
};
