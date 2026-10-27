import { isIPv4, isIPv6 } from 'node:net';
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
 * The part of an address that identifies one subscriber's line, for the limits that count per
 * address: an IPv4 address as it is, an IPv6 one as its /64 prefix (the block an ISP hands to one
 * customer, who can then use any of its 2^64 addresses: counting each would limit nothing), and an
 * IPv4-mapped IPv6 address (`::ffff:203.0.113.7`) as the IPv4 address it carries. Anything that is
 * not an address comes back unchanged.
 */
export function ipPrefix(raw: string): string {
  const address =
    raw
      .trim()
      .replace(/^\[(.*)\]$/, '$1')
      .split('%')[0] ?? '';
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return raw;

  const groups = expandIPv6(address);
  if (groups === null) return raw;
  // ::ffff:a.b.c.d, however it is written (dotted or in hex): the address of an IPv4 client that
  // reached a dual-stack socket.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6] as number;
    const low = groups[7] as number;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address (`::` expanded, a dotted tail read), null if it cannot be read. */
function expandIPv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = (dotted[1] as string).split('.').map(Number);
    const tail = [
      ((parts[0] as number) << 8) | (parts[1] as number),
      ((parts[2] as number) << 8) | (parts[3] as number),
    ];
    text = `${text.slice(0, -dotted[1]!.length)}${tail[0]!.toString(16)}:${tail[1]!.toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const read = (part: string | undefined) =>
    part === undefined || part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const head = read(halves[0]);
  const tail = halves.length === 2 ? read(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [
    ...head,
    ...new Array<number>(halves.length === 2 ? missing : 0).fill(0),
    ...tail,
  ];
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

/**
 * Who is calling, as `ipPrefix` reads it. Behind the reverse proxy (`trustProxy`) it is the last
 * address of `X-Forwarded-For`, the one the proxy itself appended: what a client wrote before it is
 * not trusted. Otherwise it is the socket's address, or `UNKNOWN_IP` where there is none (tests).
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const last = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (last) return ipPrefix(last);
  }
  try {
    const address = getConnInfo(c).remote.address;
    return address ? ipPrefix(address) : UNKNOWN_IP;
  } catch {
    return UNKNOWN_IP;
  }
}

/** The 429 answer, with the wait in `Retry-After`. */
export function tooManyRequests(c: Context, retryAfterSeconds: number): Response {
  c.header('Retry-After', String(retryAfterSeconds));
  return c.json({ error: 'rate_limited' }, 429);
}
