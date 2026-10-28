import { createHash } from 'node:crypto';
import { clampReviewInput, isAiReviewInput, type AiReviewInput } from '../../../lib/ai/input';
import { AI_CACHE_PREFIX, AI_CACHE_TTL_MS } from '../../../lib/ai/review-key';
import { parseWebDetection } from '../../../lib/checks/image-matches';
import { PROMPT_VERSION, parseReview, type GeminiFailure } from '../../../lib/google/gemini';
import type { WebDetectResult } from '../../../lib/google/vision';
import { VISION_CACHE_PREFIX, parseMatches } from '../../../lib/image/search-entry';
import { isRecord } from '../../../lib/json';
import type { AiReview, ImageMatch } from '../../../lib/model';
import type { RouteModule } from '../context';
import { callsOn, giveBackCall, takeCall } from '../daily-ceiling';
import { getAccount } from '../db';
import type { AiProvider } from '../config';
import { isOwnerProblem, upstreamReason, type GoogleDeps, type UpstreamReason } from '../google';
import { limitBody, readJsonObject } from '../http';
import { downloadPhoto, isAcceptablePhotoUrl, serverPhotoKey } from '../photo';
import { entitlement } from '../plans';
import { allowReview, mayReview, releaseReview, reserveAnalysis, usageSummary } from '../quota';
import { createSharedCache } from '../shared-cache';
import { GOOGLE_TIME_ZONE, periodIds } from '../time';
import { takeVisionCall } from '../vision-ceiling';

/**
 * The two paid steps, run with the owner's keys: `POST /v1/search` (Google Vision) and
 * `POST /v1/review` (Claude or Gemini, `AI_PROVIDER`, see `GoogleDeps.reviewer`). The server's
 * cache is shared by every account, and a client only ever hears `quota`, `capacity`, `upstream`
 * and the like: never a key, never a provider's answer.
 *
 * A photo is identified by `serverPhotoKey` (its origin and path, without the size segment of a
 * Vinted image path): the same listing seen in a grid, then on its page, is one analysis.
 */

/** The extension's cache keys start with its brand (`fripon:vision:v1:`); the server's do not. */
const unbranded = (prefix: string) => prefix.replace(/^fripon:/, '');

/**
 * How long the server keeps a Vision answer: 35 days, not the extension's 7. The same photo is a
 * free re-search for the account for the rest of the calendar month (31 days at most), and each
 * such re-search that missed the cache would be a paid Google call for nothing.
 */
export const VISION_SERVER_CACHE_TTL_MS = 35 * 24 * 60 * 60 * 1000;

/**
 * How long a failure Google will repeat is remembered: a photo it billed and could not read. The
 * same request is then answered from here, without a second paid call: this memory, not the
 * account's charge (it goes back), is what protects the bill.
 */
export const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000;

/** Shared-cache key of a Vision answer: the extension's `visionCacheKey` for the server's photo key, unbranded. */
export const visionKey = (photo: string) => `${unbranded(VISION_CACHE_PREFIX)}${photo}`;

/**
 * Shared-cache key of a review: a hash of EVERYTHING that feeds the prompt (the photo, the title,
 * the price, the description, every signal line, the fingerprint) and of the model that writes it
 * (`model`: the provider's, so switching provider never serves the other one's reviews) and the
 * prompt version. A review is shared across accounts, so one account's forged signals or description can
 * never be the answer another account gets: the extension's own key, which leaves most of it out
 * (it only reuses a review on the same device), is not enough here.
 */
export const reviewKey = (model: string, photo: string, input: AiReviewInput) =>
  `${unbranded(AI_CACHE_PREFIX)}${photo}:${createHash('sha256')
    .update(
      JSON.stringify([
        model,
        PROMPT_VERSION,
        photo,
        input.title,
        input.price,
        input.description,
        input.signals,
        input.fingerprint,
      ]),
    )
    .digest('hex')}`;

/** Where the memory of a failure of `key` is kept. */
const negativeKey = (key: string) => `neg:${key}`;

/**
 * A failure Google repeats for the same input: the photo it could not read. Never an answer
 * nobody can use (`invalid_answer`): a model's output varies from one call to the next, so the
 * same review may well work the second time, and what bounds its cost is the account's 3 reviews
 * of the photo a month, which a failure of that kind keeps counted.
 */
function isDeterministic(reason: GeminiFailure): boolean {
  return reason === 'photo';
}

/** What is read back of a remembered failure. */
function parseNegative(raw: unknown): { reason: UpstreamReason } | null {
  return isRecord(raw) && raw.reason === 'photo' ? { reason: raw.reason } : null;
}

/** The same owner problem is logged once a minute at most, so a revoked key cannot flood the log. */
const OWNER_LOG_EVERY_MS = 60_000;

/** The paid services whose key can be the owner's problem: Vision, and whichever provider reviews. */
type OwnerService = 'vision' | AiProvider;

/** Who to blame and where to fix it, per service (`alert` is the key of the once-an-hour mail). */
const OWNER_SERVICES: Record<OwnerService, { vendor: string; where: string; alert: string }> = {
  vision: { vendor: 'Google', where: 'Google Cloud', alert: 'google-vision-key' },
  gemini: { vendor: 'Google', where: 'Google Cloud or AI Studio', alert: 'google-gemini-key' },
  claude: {
    vendor: 'Anthropic',
    where: 'the Anthropic Console (credits, API key)',
    alert: 'anthropic-claude-key',
  },
};

/**
 * A step that failed. `refundable` is the account's side of it: true when the account got nothing
 * and pays nothing (Google certainly did not bill, or the failure is one it would repeat, see
 * `NEGATIVE_CACHE_TTL_MS`); false when Google may have billed and the account keeps its charge (a
 * timeout, a 5xx, an answer nobody could read once).
 */
type UpstreamFailure = {
  ok: false;
  error: 'upstream';
  reason: UpstreamReason;
  refundable: boolean;
};
/** A global ceiling is full (or the trials' share of it): Google was never called, so everything goes back. */
type CapacityFailure = { ok: false; error: 'capacity'; refundable: true };
/** Something broke on the server. `refundable` only when it broke before any Google call. */
type InternalFailure = { ok: false; error: 'internal'; refundable: boolean };
/** The account has had its reviews of the photo this month. */
type LimitFailure = { ok: false; error: 'limit'; refundable: true };
type SearchOutcome =
  { ok: true; matches: ImageMatch[] } | CapacityFailure | UpstreamFailure | InternalFailure;
type ReviewOutcome =
  | { ok: true; review: AiReview }
  | CapacityFailure
  | UpstreamFailure
  | InternalFailure
  | LimitFailure;

const upstream = (reason: UpstreamReason, refundable: boolean): UpstreamFailure => ({
  ok: false,
  error: 'upstream',
  reason,
  refundable,
});
const capacity = (): CapacityFailure => ({ ok: false, error: 'capacity', refundable: true });
const internal = (refundable: boolean): InternalFailure => ({
  ok: false,
  error: 'internal',
  refundable,
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerProxyRoutes(google: GoogleDeps): RouteModule {
  return (app, ctx) => {
    const cache = createSharedCache(ctx.db);
    // One Google call per photo (or per review key) at a time: whoever asks while it runs waits
    // for it. Each account still has its own reservation, taken and released by its own request.
    const searching = new Map<string, Promise<SearchOutcome>>();
    const reviewing = new Map<string, Promise<ReviewOutcome>>();
    const lastLogged = new Map<string, number>();

    /**
     * The server's own key was refused, its project has no billing (or its Anthropic account no
     * credit), a quota or a retired model: the owner must hear about it. The service is named as
     * it is (`vision`, `gemini` or `claude`, the provider that really ran), never by a default.
     */
    function ownerProblem(service: OwnerService, reason: GeminiFailure): void {
      if (!isOwnerProblem(reason)) return;
      const { vendor, where, alert } = OWNER_SERVICES[service];
      ctx.health.ownerProblem(service);
      ctx.alert(
        alert,
        `The ${service} step answered "${reason}" to the server's ${vendor} key. Subscribers get ` +
          `"unavailable" until it is fixed in ${where} or in the server environment (docs/cloud.md).`,
      );

      const at = ctx.now().getTime();
      const id = `${service}:${reason}`;
      const before = lastLogged.get(id);
      if (before !== undefined && at - before < OWNER_LOG_EVERY_MS) return;
      lastLogged.set(id, at);
      console.error(
        `[${vendor.toLowerCase()}] OWNER KEY PROBLEM: ${service} answered "${reason}" to the server's key. ` +
          `Subscribers get "unavailable" until it is fixed in ${where} or in the server environment.`,
      );
    }

    /** The ceiling is full: the owner hears about it (once an hour), whoever's call it was. */
    function ceilingReached(service: 'vision' | 'review', cap: number): void {
      const name = service === 'vision' ? 'Vision' : `AI review (${google.reviewer.provider})`;
      ctx.alert(
        `${service}-ceiling`,
        `The global ${name} ceiling of ${cap} calls a day (Pacific time) is reached: ` +
          'subscribers get "capacity" until the next day. Raise ' +
          `GLOBAL_DAILY_${service === 'vision' ? 'VISION' : 'REVIEW'}_CAP if it is real use.`,
      );
    }

    /** Writes to the shared cache; a failed write only means the next request asks Google again. */
    function remember(key: string, value: unknown, ttlMs: number): void {
      try {
        cache.set(key, value, ctx.now().getTime(), ttlMs);
      } catch (error) {
        console.error(`[cache] could not store an answer:`, message(error));
      }
    }

    /**
     * The Vision step for a photo no cache holds, its call to the ceiling already taken (`day`,
     * `trial`): download, call, cache. Never throws: a failure of the server itself is an outcome,
     * refundable only while Google was not called.
     */
    async function searchGoogle(
      photoUrl: string,
      photo: string,
      day: string,
      trial: boolean,
    ): Promise<SearchOutcome> {
      let called = false;
      try {
        const image = await downloadPhoto(google.fetch, photoUrl);
        if (!image) {
          // Google was never called: nothing to bill.
          giveBackCall(ctx.db, 'vision_calls', day, trial);
          return upstream('photo', true);
        }

        called = true;
        let result: WebDetectResult;
        try {
          result = await google.webDetect(image.base64, ctx.config.googleVisionKey);
        } catch {
          result = { ok: false, reason: 'network', refundable: false };
        }
        if (!result.ok) {
          // The one rule of the refund lives in the extension's `readRefusal`: only a call Google
          // certainly did not bill goes back to the day's ceiling.
          if (result.refundable) giveBackCall(ctx.db, 'vision_calls', day, trial);
          ownerProblem('vision', result.reason);
          const reason = upstreamReason(result.reason);
          if (!result.refundable && isDeterministic(result.reason)) {
            // Billed, and it would be again: remembered, and the account pays nothing for it.
            remember(negativeKey(visionKey(photo)), { reason }, NEGATIVE_CACHE_TTL_MS);
            return upstream(reason, true);
          }
          return upstream(reason, result.refundable);
        }

        const matches = parseWebDetection(result.webDetection);
        remember(visionKey(photo), matches, VISION_SERVER_CACHE_TTL_MS);
        return { ok: true, matches };
      } catch (error) {
        console.error('[proxy] a search failed on the server:', message(error));
        if (!called) giveBackCall(ctx.db, 'vision_calls', day, trial);
        return internal(!called);
      }
    }

    /**
     * The matches of a photo: a search already running, the shared cache, a failure remembered, or
     * a new Google call (which first takes its place under the day's ceiling, and for a free trial
     * under the trials' share of it).
     */
    function matchesOf(photoUrl: string, photo: string, trial: boolean): Promise<SearchOutcome> {
      const running = searching.get(photo);
      if (running) return running;

      const at = ctx.now().getTime();
      const cached = cache.get(visionKey(photo), at, parseMatches);
      if (cached) return Promise.resolve({ ok: true, matches: cached });
      const failed = cache.get(negativeKey(visionKey(photo)), at, parseNegative);
      if (failed) return Promise.resolve(upstream(failed.reason, true));

      // Google's quota resets at midnight Pacific time: the ceiling counts on that day.
      const day = periodIds(ctx.now(), GOOGLE_TIME_ZONE).day;
      const cap = ctx.config.globalDailyVisionCap;
      if (!takeVisionCall(ctx.db, day, cap, trial)) {
        if (callsOn(ctx.db, 'vision_calls', day) >= cap) ceilingReached('vision', cap);
        return Promise.resolve(capacity());
      }

      const search = searchGoogle(photoUrl, photo, day, trial).finally(() =>
        searching.delete(photo),
      );
      searching.set(photo, search);
      return search;
    }

    /**
     * The AI step (`google.reviewer`) for a review no cache holds, its call to the ceiling taken
     * and the account's review counted: download, call, cache. Never throws. The account's review
     * goes back when the account got nothing for it (not billed, or a failure it would repeat) and
     * stays counted when the provider may have billed.
     */
    async function reviewGoogle(
      input: AiReviewInput,
      key: string,
      photo: string,
      accountId: string,
      countedAt: Date,
      day: string,
    ): Promise<ReviewOutcome> {
      const giveBackReview = () => releaseReview(ctx.db, accountId, photo, countedAt);
      let called = false;
      try {
        const image = await downloadPhoto(google.fetch, input.photoUrl);
        if (!image) {
          // Google was never called: nothing to bill.
          giveBackCall(ctx.db, 'gemini_calls', day);
          giveBackReview();
          return upstream('photo', true);
        }

        called = true;
        let result: Awaited<ReturnType<GoogleDeps['reviewer']['review']>>;
        try {
          result = await google.reviewer.review({
            photo: image,
            title: input.title,
            description: input.description,
            price: input.price,
            signals: input.signals,
          });
        } catch {
          result = { ok: false, reason: 'network', refundable: false };
        }
        if (!result.ok) {
          // Same rule as Vision: only a call the provider certainly did not bill goes back to the ceiling.
          if (result.refundable) giveBackCall(ctx.db, 'gemini_calls', day);
          // An unrecognised 400 may be this very photo (a format the model refuses): not the key's
          // fault, so neither a mail nor a red `/healthz`.
          if (!result.specific) ownerProblem(google.reviewer.provider, result.reason);
          const reason = upstreamReason(result.reason);
          if (result.refundable || isDeterministic(result.reason)) {
            if (!result.refundable) {
              remember(negativeKey(key), { reason }, NEGATIVE_CACHE_TTL_MS);
            }
            giveBackReview();
            return upstream(reason, true);
          }
          return upstream(reason, false);
        }

        remember(key, result.review, AI_CACHE_TTL_MS);
        return { ok: true, review: result.review };
      } catch (error) {
        console.error('[proxy] a review failed on the server:', message(error));
        if (!called) {
          giveBackCall(ctx.db, 'gemini_calls', day);
          giveBackReview();
        }
        return internal(!called);
      }
    }

    /**
     * The review for `key`: the shared cache, a failure remembered, a call somebody else is
     * already making, or a new AI call. Only that last one costs anything, so only it counts
     * against the account's 3 reviews of the photo this month (and the global ceiling).
     */
    function reviewOf(
      input: AiReviewInput,
      key: string,
      photo: string,
      accountId: string,
    ): Promise<ReviewOutcome> {
      const running = reviewing.get(key);
      if (running) return running;

      const at = ctx.now().getTime();
      const cached = cache.get(key, at, parseReview);
      if (cached) return Promise.resolve({ ok: true, review: cached });
      const failed = cache.get(negativeKey(key), at, parseNegative);
      if (failed) return Promise.resolve(upstream(failed.reason, true));

      const countedAt = ctx.now();
      if (!allowReview(ctx.db, accountId, photo, countedAt)) {
        return Promise.resolve({ ok: false, error: 'limit', refundable: true });
      }
      const day = periodIds(countedAt, GOOGLE_TIME_ZONE).day;
      const cap = ctx.config.globalDailyReviewCap;
      let taken: boolean;
      try {
        taken = takeCall(ctx.db, 'gemini_calls', day, cap);
      } catch (error) {
        // No call was made: the review that was just counted goes back.
        releaseReview(ctx.db, accountId, photo, countedAt);
        throw error;
      }
      if (!taken) {
        releaseReview(ctx.db, accountId, photo, countedAt);
        if (callsOn(ctx.db, 'gemini_calls', day) >= cap) ceilingReached('review', cap);
        return Promise.resolve(capacity());
      }

      const review = reviewGoogle(input, key, photo, accountId, countedAt, day).finally(() =>
        reviewing.delete(key),
      );
      reviewing.set(key, review);
      return review;
    }

    app.post('/v1/search', ctx.requireAccount, limitBody, async (c) => {
      const body = await readJsonObject(c);
      const photoUrl = body?.photoUrl;
      if (typeof photoUrl !== 'string') return c.json({ error: 'invalid_request' }, 400);
      if (!isAcceptablePhotoUrl(photoUrl)) return c.json({ error: 'invalid_photo' }, 400);

      let account = c.get('account');
      const photo = serverPhotoKey(photoUrl);
      let attempt = reserveAnalysis(ctx.db, account.id, photo, ctx.now());
      if (!attempt.ok && attempt.reason === 'none') {
        // A subscription that looks over may have been renewed without the webhook having
        // reached us: Stripe is asked (at most every 10 minutes) before the account is refused.
        account = await ctx.subscriptions.refresh(account);
        attempt = reserveAnalysis(ctx.db, account.id, photo, ctx.now());
      }
      const reservation = attempt;
      if (!reservation.ok) return c.json({ error: 'quota', reason: reservation.reason }, 402);

      // The charge goes back only when the account got nothing for it and Google did not keep the
      // money (`refundable`), like the extension's own credit: a call that may have been processed
      // keeps the analysis charged (the same photo again this month is free). A failure of the
      // server itself goes back too, as long as no Google call was made.
      const refund = () => {
        if (reservation.charged) reservation.release();
      };
      const trial = entitlement(account, ctx.now()).kind !== 'plan';
      let outcome: SearchOutcome;
      try {
        outcome = await matchesOf(photoUrl, photo, trial);
      } catch (error) {
        // Thrown before anything was started (a cache read, the ceiling): no call was made.
        refund();
        throw error;
      }
      if (!outcome.ok) {
        if (outcome.refundable) refund();
        if (outcome.error === 'capacity') return c.json({ error: 'capacity' }, 503);
        if (outcome.error === 'internal') return c.json({ error: 'internal' }, 500);
        return c.json({ error: 'upstream', reason: outcome.reason }, 502);
      }

      return c.json({
        matches: outcome.matches,
        charged: reservation.charged,
        // Read again: the charge just changed the counters (and the trial) of the row read at sign-in.
        usage: usageSummary(ctx.db, getAccount(ctx.db, account.id) ?? account, ctx.now()),
      });
    });

    app.post('/v1/review', ctx.requireAccount, limitBody, async (c) => {
      const body = await readJsonObject(c);
      const raw = body?.input;
      if (!isAiReviewInput(raw)) return c.json({ error: 'invalid_request' }, 400);
      if (!isAcceptablePhotoUrl(raw.photoUrl)) return c.json({ error: 'invalid_photo' }, 400);

      // The extension's own clamp: the prompt and the cache key never see more than it allows.
      const input = clampReviewInput(raw);
      const photo = serverPhotoKey(input.photoUrl);
      const account = c.get('account');
      if (!mayReview(ctx.db, account.id, photo, ctx.now())) {
        return c.json({ error: 'not_searched' }, 403);
      }

      // Nothing to give back here: the review is counted, and given back, by the one request that
      // really calls the AI (`reviewOf`), never by a request the cache or another call answered.
      const key = reviewKey(google.reviewer.model, photo, input);
      const outcome = await reviewOf(input, key, photo, account.id);
      if (!outcome.ok) {
        if (outcome.error === 'capacity') return c.json({ error: 'capacity' }, 503);
        if (outcome.error === 'internal') return c.json({ error: 'internal' }, 500);
        // The month's 3 reviews of this photo are used: not the same thing as a photo never
        // searched, which the extension answers by searching it (and would only repeat here).
        if (outcome.error === 'limit') return c.json({ error: 'review_limit' }, 403);
        return c.json({ error: 'upstream', reason: outcome.reason }, 502);
      }
      return c.json({ review: outcome.review });
    });
  };
}
