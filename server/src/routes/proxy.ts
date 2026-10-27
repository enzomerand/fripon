import { createHash } from 'node:crypto';
import { clampReviewInput, isAiReviewInput, type AiReviewInput } from '../../../lib/ai/input';
import { AI_CACHE_PREFIX, AI_CACHE_TTL_MS, aiCacheDigest } from '../../../lib/ai/review-key';
import { parseWebDetection } from '../../../lib/checks/image-matches';
import { parseReview, type GeminiFailure } from '../../../lib/google/gemini';
import type { WebDetectResult } from '../../../lib/google/vision';
import { photoKey } from '../../../lib/image/photo-url';
import { VISION_CACHE_PREFIX, parseMatches } from '../../../lib/image/search-entry';
import type { AiReview, ImageMatch } from '../../../lib/model';
import type { RouteModule } from '../context';
import { getAccount } from '../db';
import { isOwnerProblem, upstreamReason, type GoogleDeps, type UpstreamReason } from '../google';
import { limitBody, readJsonObject } from '../http';
import { downloadPhoto, isAcceptablePhotoUrl } from '../photo';
import { allowReview, releaseReview, reserveAnalysis, usageSummary } from '../quota';
import { giveBackGeminiCall, takeGeminiCall } from '../gemini-ceiling';
import { createSharedCache } from '../shared-cache';
import { GOOGLE_TIME_ZONE, periodIds } from '../time';
import { giveBackVisionCall, takeVisionCall } from '../vision-ceiling';

/**
 * The two paid steps, run with the owner's Google keys: `POST /v1/search` (Vision) and
 * `POST /v1/review` (Gemini). The server's cache is shared by every account, its keys are the
 * extension's own cache keys without the `fripon:` prefix (`proxy.test.ts` checks they do not
 * drift), and a client only ever hears `quota`, `capacity`, `upstream` and the like: never a key,
 * never a Google answer.
 */

/** The extension's cache keys start with its brand (`fripon:vision:v1:`); the server's do not. */
const unbranded = (prefix: string) => prefix.replace(/^fripon:/, '');

/**
 * How long the server keeps a Vision answer: 35 days, not the extension's 7. The same photo is a
 * free re-search for the account for the rest of the calendar month (31 days at most), and each
 * such re-search that missed the cache would be a paid Google call for nothing.
 */
export const VISION_SERVER_CACHE_TTL_MS = 35 * 24 * 60 * 60 * 1000;

/** Shared-cache key of a Vision answer: the extension's `visionCacheKey`, unbranded. */
export const visionKey = (photo: string) => `${unbranded(VISION_CACHE_PREFIX)}${photo}`;
/**
 * Shared-cache key of a review: the extension's `aiCacheKey`, unbranded, then a hash of the
 * description. The extension leaves the description out of its own key (it only reuses a review
 * on the same device); here a review is shared across accounts, and one account's description
 * must not be answered with a review written for another's.
 */
export const reviewKey = (photo: string, input: AiReviewInput) =>
  `${unbranded(AI_CACHE_PREFIX)}${photo}:${aiCacheDigest(input)}:${descriptionHash(input.description)}`;

function descriptionHash(description: string): string {
  return createHash('sha256').update(description).digest('hex').slice(0, 16);
}

/** The same owner problem is logged once a minute at most, so a revoked key cannot flood the log. */
const OWNER_LOG_EVERY_MS = 60_000;

/**
 * A step that failed. `refundable` is the extension's rule (`readRefusal`): true only when Google
 * certainly did not bill the call (never made, or refused with a named reason). A call that may
 * have been processed (a timeout, a 5xx, an answer nobody could read) keeps the account's charge.
 */
type UpstreamFailure = {
  ok: false;
  error: 'upstream';
  reason: UpstreamReason;
  refundable: boolean;
};
/** The global daily ceiling is full: Google was never called, so everything goes back. */
type CapacityFailure = { ok: false; error: 'capacity'; refundable: true };
type SearchOutcome = { ok: true; matches: ImageMatch[] } | CapacityFailure | UpstreamFailure;
type ReviewOutcome = { ok: true; review: AiReview } | CapacityFailure | UpstreamFailure;

const upstream = (reason: UpstreamReason, refundable: boolean): UpstreamFailure => ({
  ok: false,
  error: 'upstream',
  reason,
  refundable,
});
const capacity = (): CapacityFailure => ({ ok: false, error: 'capacity', refundable: true });

export function registerProxyRoutes(google: GoogleDeps): RouteModule {
  return (app, ctx) => {
    const cache = createSharedCache(ctx.db);
    // One Google call per photo (or per review key) at a time: whoever asks while it runs waits
    // for it. Each account still has its own reservation, taken and released by its own request.
    const searching = new Map<string, Promise<SearchOutcome>>();
    const reviewing = new Map<string, Promise<ReviewOutcome>>();
    const lastLogged = new Map<string, number>();

    /** A refused key, a project without billing, a quota or a retired model: the owner must hear about it. */
    function logOwnerProblem(service: 'vision' | 'gemini', reason: GeminiFailure): void {
      if (!isOwnerProblem(reason)) return;
      const at = ctx.now().getTime();
      const id = `${service}:${reason}`;
      const before = lastLogged.get(id);
      if (before !== undefined && at - before < OWNER_LOG_EVERY_MS) return;
      lastLogged.set(id, at);
      console.error(
        `[google] OWNER KEY PROBLEM: ${service} answered "${reason}" to the server's key. ` +
          'Subscribers get "unavailable" until it is fixed in Google Cloud or in the server environment.',
      );
    }

    /** The Vision step for a photo no cache holds: ceiling, download, call, cache. */
    async function searchGoogle(photoUrl: string, photo: string): Promise<SearchOutcome> {
      // Google's quota resets at midnight Pacific time: the ceiling counts on that day.
      const day = periodIds(ctx.now(), GOOGLE_TIME_ZONE).day;
      if (!takeVisionCall(ctx.db, day, ctx.config.globalDailyVisionCap)) return capacity();

      const image = await downloadPhoto(google.fetch, photoUrl);
      if (!image) {
        // Google was never called: nothing to bill.
        giveBackVisionCall(ctx.db, day);
        return upstream('photo', true);
      }

      let result: WebDetectResult;
      try {
        result = await google.webDetect(image.base64, ctx.config.googleVisionKey);
      } catch {
        result = { ok: false, reason: 'network', refundable: false };
      }
      if (!result.ok) {
        // The one rule of the refund lives in the extension's `readRefusal`: only a call Google
        // certainly did not bill goes back to the day's ceiling.
        if (result.refundable) giveBackVisionCall(ctx.db, day);
        logOwnerProblem('vision', result.reason);
        return upstream(upstreamReason(result.reason), result.refundable);
      }

      const matches = parseWebDetection(result.webDetection);
      cache.set(visionKey(photo), matches, ctx.now().getTime(), VISION_SERVER_CACHE_TTL_MS);
      return { ok: true, matches };
    }

    /** The matches of a photo: the shared cache, a search already running, or a new Google call. */
    function matchesOf(photoUrl: string, photo: string): Promise<SearchOutcome> {
      const running = searching.get(photo);
      if (running) return running;

      const cached = cache.get(visionKey(photo), ctx.now().getTime(), parseMatches);
      if (cached) return Promise.resolve({ ok: true, matches: cached });

      const search = searchGoogle(photoUrl, photo).finally(() => searching.delete(photo));
      searching.set(photo, search);
      return search;
    }

    /** The Gemini step for a review no cache holds: ceiling, download, call, cache. */
    async function reviewGoogle(input: AiReviewInput, key: string): Promise<ReviewOutcome> {
      const day = periodIds(ctx.now(), GOOGLE_TIME_ZONE).day;
      if (!takeGeminiCall(ctx.db, day, ctx.config.globalDailyGeminiCap)) return capacity();

      const image = await downloadPhoto(google.fetch, input.photoUrl);
      if (!image) {
        // Google was never called: nothing to bill.
        giveBackGeminiCall(ctx.db, day);
        return upstream('photo', true);
      }

      let result: Awaited<ReturnType<GoogleDeps['reviewListing']>>;
      try {
        result = await google.reviewListing(
          {
            photo: image,
            title: input.title,
            description: input.description,
            price: input.price,
            signals: input.signals,
          },
          ctx.config.geminiKey,
        );
      } catch {
        result = { ok: false, reason: 'network', refundable: false };
      }
      if (!result.ok) {
        // Same rule as Vision: only a call Google certainly did not bill goes back to the ceiling.
        if (result.refundable) giveBackGeminiCall(ctx.db, day);
        logOwnerProblem('gemini', result.reason);
        return upstream(upstreamReason(result.reason), result.refundable);
      }

      cache.set(key, result.review, ctx.now().getTime(), AI_CACHE_TTL_MS);
      return { ok: true, review: result.review };
    }

    function reviewOf(input: AiReviewInput, key: string): Promise<ReviewOutcome> {
      const running = reviewing.get(key);
      if (running) return running;

      const cached = cache.get(key, ctx.now().getTime(), parseReview);
      if (cached) return Promise.resolve({ ok: true, review: cached });

      const review = reviewGoogle(input, key).finally(() => reviewing.delete(key));
      reviewing.set(key, review);
      return review;
    }

    app.post('/v1/search', ctx.requireAccount, limitBody, async (c) => {
      const body = await readJsonObject(c);
      const photoUrl = body?.photoUrl;
      if (typeof photoUrl !== 'string') return c.json({ error: 'invalid_request' }, 400);
      if (!isAcceptablePhotoUrl(photoUrl)) return c.json({ error: 'invalid_photo' }, 400);

      const account = c.get('account');
      const photo = photoKey(photoUrl);
      const reservation = reserveAnalysis(ctx.db, account.id, photo, ctx.now());
      if (!reservation.ok) return c.json({ error: 'quota', reason: reservation.reason }, 402);

      // The charge goes back only when Google certainly did not bill (`refundable`), like the
      // extension's own credit: a call that may have been processed keeps the analysis charged
      // (the same photo again this month is free). A crash of the server itself is no fault of the
      // account either, so it goes back too.
      const refund = () => {
        if (reservation.charged) reservation.release();
      };
      let outcome: SearchOutcome;
      try {
        outcome = await matchesOf(photoUrl, photo);
      } catch (error) {
        refund();
        throw error;
      }
      if (!outcome.ok) {
        if (outcome.refundable) refund();
        return outcome.error === 'capacity'
          ? c.json({ error: 'capacity' }, 503)
          : c.json({ error: 'upstream', reason: outcome.reason }, 502);
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
      const photo = photoKey(input.photoUrl);
      const account = c.get('account');
      if (!allowReview(ctx.db, account.id, photo, ctx.now())) {
        return c.json({ error: 'not_searched' }, 403);
      }

      let outcome: ReviewOutcome;
      try {
        outcome = await reviewOf(input, reviewKey(photo, input));
      } catch (error) {
        releaseReview(ctx.db, account.id, photo);
        throw error;
      }
      if (!outcome.ok) {
        // The review counts against the account unless Google certainly did not bill it.
        if (outcome.refundable) releaseReview(ctx.db, account.id, photo);
        return outcome.error === 'capacity'
          ? c.json({ error: 'capacity' }, 503)
          : c.json({ error: 'upstream', reason: outcome.reason }, 502);
      }
      return c.json({ review: outcome.review });
    });
  };
}
