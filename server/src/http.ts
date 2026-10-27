import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

/** A request body is small JSON; anything bigger is refused before it is read. */
export const MAX_BODY_BYTES = 16 * 1024;

/** Middleware for a route that reads a JSON body: 413 above `MAX_BODY_BYTES`. */
export const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json({ error: 'payload_too_large' }, 413),
});

/**
 * The body as a JSON object, or null if it is anything else. The content type must be
 * `application/json`: a browser page cannot send that cross-site without a preflight, which this
 * server (no CORS headers) never approves. That keeps other sites from calling it.
 */
export async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) return null;
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The token of an `Authorization: Bearer <token>` header, null without one. */
export function bearerToken(c: Context): string | null {
  const match = /^Bearer +(\S+)$/i.exec(c.req.header('authorization') ?? '');
  return match?.[1] ?? null;
}

/** What `clientIp` answers when the request carries no address (a test, an unreadable socket). */
export const UNKNOWN_IP = 'unknown';

/**
 * Who is calling. Behind the reverse proxy (`trustProxy`) it is the last address of
 * `X-Forwarded-For`, the one the proxy itself appended: what a client wrote before it is not
 * trusted. Otherwise it is the socket's address, or `UNKNOWN_IP` where there is none (tests).
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const last = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? UNKNOWN_IP;
  } catch {
    return UNKNOWN_IP;
  }
}

/** The 429 answer, with the wait in `Retry-After`. */
export function tooManyRequests(c: Context, retryAfterSeconds: number): Response {
  c.header('Retry-After', String(retryAfterSeconds));
  return c.json({ error: 'rate_limited' }, 429);
}
