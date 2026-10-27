import type { AiReviewInput } from '../ai/input';
import type { FetchLike } from '../fetch';
import { parseReview } from '../google/gemini';
import { isRecord } from '../json';
import type { AiReview, ImageMatch } from '../model';
import { CLOUD_ORIGIN, CLOUD_SLOW_TIMEOUT_MS, CLOUD_TIMEOUT_MS } from './config';
import { expireSession, loadSession } from './session';
import {
  parseMe,
  parseUsage,
  type CloudSubscription,
  type CloudUsage,
  type DeleteAccountResult,
  type PriceKey,
  type RequestCodeResult,
} from './types';

/** Where the client finds the token of the session, and how it ends it. Injected for tests. */
export interface SessionAccess {
  token(): Promise<string | null>;
  /** The server refused `token`: the session is over, but only if `token` is still the stored one. */
  expire(token: string): Promise<void>;
}

/** The session of `storage.local`. */
export const storedSession: SessionAccess = {
  token: async () => (await loadSession())?.token ?? null,
  expire: (token) => expireSession(token),
};

export interface CloudClientDeps {
  fetch: FetchLike;
  session: SessionAccess;
  origin?: string;
}

/** Why a call that needs the account did not get an answer from it. */
export type CallFailure = 'signed_out' | 'network';

export type MeResult =
  | { ok: true; me: { email: string; usage: CloudUsage; subscription: CloudSubscription | null } }
  | { ok: false; reason: CallFailure };

/** Why a search was not served. */
export type SearchFailure =
  | CallFailure
  /** 402: over a cap, the trial is used up, or no plan. */
  | 'quota'
  /** 400: the server cannot use this photo. */
  | 'photo'
  /** 429. */
  | 'rate_limited'
  /** 502 or 503: Google or the server is out of reach, or full. */
  | 'unavailable';

export type SearchResult =
  | { ok: true; matches: ImageMatch[]; charged: boolean; usage: CloudUsage | null }
  | { ok: false; reason: SearchFailure };

/**
 * Why a review was not served. `not_searched`: the server never served this photo to the account
 * (lately): a search makes it servable. `review_limit`: the account has had its 3 reviews of this
 * photo this month: nothing the client does changes that. No `quota`: the review is never refused
 * for want of analyses (the search is what costs one).
 */
export type ReviewFailure =
  Exclude<SearchFailure, 'quota'> | 'not_searched' | 'review_limit' | 'invalid_answer';

export type ReviewResult = { ok: true; review: AiReview } | { ok: false; reason: ReviewFailure };

export type LinkCallResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason: 'signed_out' | 'no_customer' | 'rate_limited' | 'unavailable' | 'network';
    };

export interface CloudClient {
  requestCode(email: string): Promise<RequestCodeResult>;
  /** The token of the new session; the caller stores it. */
  verify(
    email: string,
    code: string,
  ): Promise<
    { ok: true; token: string } | { ok: false; reason: 'invalid_code' | 'rate_limited' | 'network' }
  >;
  /** Ends the session of `token` at the server. Never rejects; the answer does not matter. */
  logout(token: string): Promise<void>;
  me(): Promise<MeResult>;
  search(photoUrl: string): Promise<SearchResult>;
  review(input: AiReviewInput): Promise<ReviewResult>;
  checkout(price: PriceKey): Promise<LinkCallResult>;
  portal(): Promise<LinkCallResult>;
  /** Deletes the account and its history at the server. */
  deleteAccount(): Promise<DeleteAccountResult>;
}

/** What came back: the status and the JSON body (undefined when it was not JSON), or null. */
type Reply = { status: number; body: unknown } | null;

const errorWord = (body: unknown): string | undefined =>
  isRecord(body) && typeof body.error === 'string' ? body.error : undefined;

/** The matches of a search, as the extension's cache and card take them: no price, a real link. */
function parseMatches(raw: unknown): ImageMatch[] | null {
  if (!Array.isArray(raw)) return null;
  const matches: ImageMatch[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { platform, url, exact } = item;
    if (typeof platform !== 'string' || typeof url !== 'string' || typeof exact !== 'boolean') {
      continue;
    }
    // The URL ends up in a link of the card.
    if (platform === '' || !/^https?:\/\//i.test(url)) continue;
    matches.push({ platform, url, exact, price: null });
  }
  return matches;
}

/** An https address: what Stripe's pages are, and all the background will open. */
function parseLink(body: unknown): string | null {
  if (!isRecord(body) || typeof body.url !== 'string') return null;
  try {
    return new URL(body.url).protocol === 'https:' ? body.url : null;
  } catch {
    return null;
  }
}

/**
 * Typed calls to the Fripon Cloud API. Every call has a timeout (the body included) and never
 * rejects: what went wrong is a word of the result. A `401` on a call made with the session ends
 * it (`expire`: the address stays, to sign in again). The token is only ever put in the `Authorization` header.
 */
export function createCloudClient(deps: CloudClientDeps): CloudClient {
  const origin = deps.origin ?? CLOUD_ORIGIN;

  async function send(
    path: string,
    options: {
      body?: unknown;
      token?: string;
      timeoutMs?: number;
      method?: 'GET' | 'POST' | 'DELETE';
    },
  ): Promise<Reply> {
    const { body, token, timeoutMs = CLOUD_TIMEOUT_MS, method = 'POST' } = options;
    try {
      const response = await deps.fetch(`${origin}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...(token !== undefined && { authorization: `Bearer ${token}` }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // An answer without a usable body (204, an error page) is still an answer.
      const parsed: unknown = await response.json().catch(() => undefined);
      return { status: response.status, body: parsed };
    } catch {
      return null;
    }
  }

  /** A call that needs the session: no session, or a 401, is `signed_out`. */
  async function authed(
    path: string,
    options: { body?: unknown; timeoutMs?: number; method?: 'GET' | 'POST' | 'DELETE' } = {},
  ): Promise<Reply | 'signed_out'> {
    const token = await deps.session.token().catch(() => null);
    if (token === null) return 'signed_out';
    const reply = await send(path, { ...options, token });
    if (reply?.status === 401) {
      await deps.session.expire(token).catch(() => undefined);
      return 'signed_out';
    }
    return reply;
  }

  /** The words of a refused search or review, shared by both. */
  function refused(reply: {
    status: number;
    body: unknown;
  }): SearchFailure | 'not_searched' | 'review_limit' {
    const word = errorWord(reply.body);
    switch (reply.status) {
      case 400:
        return word === 'invalid_photo' ? 'photo' : 'unavailable';
      case 402:
        return 'quota';
      case 403:
        if (word === 'not_searched' || word === 'review_limit') return word;
        return 'unavailable';
      case 429:
        return 'rate_limited';
      case 502:
      case 503:
        return 'unavailable';
      default:
        return 'network';
    }
  }

  /** A call that answers with a Stripe page to open. */
  async function billingLink(path: string, body: unknown): Promise<LinkCallResult> {
    const reply = await authed(path, { body });
    if (reply === 'signed_out') return { ok: false, reason: 'signed_out' };
    if (reply === null) return { ok: false, reason: 'network' };
    if (reply.status === 200) {
      const url = parseLink(reply.body);
      return url ? { ok: true, url } : { ok: false, reason: 'unavailable' };
    }
    if (reply.status === 409) return { ok: false, reason: 'no_customer' };
    if (reply.status === 429) return { ok: false, reason: 'rate_limited' };
    return { ok: false, reason: 'unavailable' };
  }

  return {
    async requestCode(email) {
      const reply = await send('/v1/auth/code', { body: { email } });
      if (reply === null) return { ok: false, reason: 'network' };
      if (reply.status === 204) return { ok: true };
      if (reply.status === 400) return { ok: false, reason: 'invalid_email' };
      if (reply.status === 429) return { ok: false, reason: 'rate_limited' };
      return { ok: false, reason: 'mail_unavailable' };
    },

    async verify(email, code) {
      const reply = await send('/v1/auth/verify', { body: { email, code } });
      if (reply === null) return { ok: false, reason: 'network' };
      if (reply.status === 200) {
        const token = isRecord(reply.body) ? reply.body.token : undefined;
        return typeof token === 'string' && token !== ''
          ? { ok: true, token }
          : { ok: false, reason: 'network' };
      }
      if (reply.status === 400) return { ok: false, reason: 'invalid_code' };
      if (reply.status === 429) return { ok: false, reason: 'rate_limited' };
      return { ok: false, reason: 'network' };
    },

    async logout(token) {
      await send('/v1/auth/logout', { token });
    },

    async me() {
      const reply = await authed('/v1/me', { method: 'GET' });
      if (reply === 'signed_out') return { ok: false, reason: 'signed_out' };
      if (reply?.status !== 200) return { ok: false, reason: 'network' };
      const me = parseMe(reply.body);
      return me ? { ok: true, me } : { ok: false, reason: 'network' };
    },

    async search(photoUrl) {
      const reply = await authed('/v1/search', {
        body: { photoUrl },
        timeoutMs: CLOUD_SLOW_TIMEOUT_MS,
      });
      if (reply === 'signed_out') return { ok: false, reason: 'signed_out' };
      if (reply === null) return { ok: false, reason: 'network' };
      if (reply.status !== 200) {
        const reason = refused(reply);
        // Nothing here asks for a review: a 403 is the server not liking the request.
        return {
          ok: false,
          reason: reason === 'not_searched' || reason === 'review_limit' ? 'unavailable' : reason,
        };
      }
      const matches = isRecord(reply.body) ? parseMatches(reply.body.matches) : null;
      if (!matches || !isRecord(reply.body)) return { ok: false, reason: 'unavailable' };
      return {
        ok: true,
        matches,
        charged: reply.body.charged === true,
        usage: parseUsage(reply.body.usage),
      };
    },

    async review(input) {
      const reply = await authed('/v1/review', {
        body: { input },
        timeoutMs: CLOUD_SLOW_TIMEOUT_MS,
      });
      if (reply === 'signed_out') return { ok: false, reason: 'signed_out' };
      if (reply === null) return { ok: false, reason: 'network' };
      if (reply.status !== 200) {
        const reason = refused(reply);
        // The server never refuses a review for want of analyses: a 402 is not its contract.
        return { ok: false, reason: reason === 'quota' ? 'unavailable' : reason };
      }
      const review = isRecord(reply.body) ? parseReview(reply.body.review) : null;
      return review ? { ok: true, review } : { ok: false, reason: 'invalid_answer' };
    },

    checkout: (price) => billingLink('/v1/billing/checkout', { price }),
    portal: () => billingLink('/v1/billing/portal', {}),

    async deleteAccount() {
      const reply = await authed('/v1/account', { method: 'DELETE' });
      if (reply === 'signed_out') return { ok: false, reason: 'signed_out' };
      if (reply === null) return { ok: false, reason: 'network' };
      if (reply.status === 204) return { ok: true };
      if (reply.status === 409 && errorWord(reply.body) === 'active_subscription') {
        return { ok: false, reason: 'active_subscription' };
      }
      if (reply.status === 429) return { ok: false, reason: 'rate_limited' };
      return { ok: false, reason: 'unavailable' };
    },
  };
}
