import { clampReviewInput, isAiReviewInput, type AiReviewInput } from '../../../lib/ai/input';
import { AI_CACHE_PREFIX, AI_CACHE_TTL_MS, aiCacheDigest } from '../../../lib/ai/review-key';
import { parseWebDetection } from '../../../lib/checks/image-matches';
import { parseReview, type GeminiFailure } from '../../../lib/google/gemini';
import type { WebDetectResult } from '../../../lib/google/vision';
import { photoKey } from '../../../lib/image/photo-url';
import {
  VISION_CACHE_PREFIX,
  VISION_CACHE_TTL_MS,
  parseMatches,
} from '../../../lib/image/search-entry';
import type { AiReview, ImageMatch } from '../../../lib/model';
import type { RouteModule } from '../context';
import { getAccount } from '../db';
import { isOwnerProblem, upstreamReason, type GoogleDeps, type UpstreamReason } from '../google';
import { limitBody, readJsonObject } from '../http';
import { downloadPhoto, isAcceptablePhotoUrl } from '../photo';
import { allowReview, releaseReview, reserveAnalysis, usageSummary } from '../quota';
import { createSharedCache } from '../shared-cache';
import { periodIds } from '../time';
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

/** Shared-cache key of a Vision answer: the extension's `visionCacheKey`, unbranded. */
export const visionKey = (photo: string) => `${unbranded(VISION_CACHE_PREFIX)}${photo}`;
/** Shared-cache key of a review: the extension's `aiCacheKey`, unbranded. */
export const reviewKey = (photo: string, input: AiReviewInput) =>
  `${unbranded(AI_CACHE_PREFIX)}${photo}:${aiCacheDigest(input)}`;

/** The same owner problem is logged once a minute at most, so a revoked key cannot flood the log. */
const OWNER_LOG_EVERY_MS = 60_000;

type UpstreamFailure = { ok: false; error: 'upstream'; reason: UpstreamReason };
type SearchOutcome =
  { ok: true; matches: ImageMatch[] } | { ok: false; error: 'capacity' } | UpstreamFailure;
type ReviewOutcome = { ok: true; review: AiReview } | UpstreamFailure;

const upstream = (reason: UpstreamReason): UpstreamFailure => ({
  ok: false,
  error: 'upstream',
  reason,
});

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
      const day = periodIds(ctx.now()).day;
      if (!takeVisionCall(ctx.db, day, ctx.config.globalDailyVisionCap)) {
        return { ok: false, error: 'capacity' };
      }

      const image = await downloadPhoto(google.fetch, photoUrl);
      if (!image) {
        // Google was never called: nothing to bill.
        giveBackVisionCall(ctx.db, day);
        return upstream('photo');
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
        return upstream(upstreamReason(result.reason));
      }

      const matches = parseWebDetection(result.webDetection);
      cache.set(visionKey(photo), matches, ctx.now().getTime(), VISION_CACHE_TTL_MS);
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

    /** The Gemini step for a review no cache holds: download, call, cache. */
    async function reviewGoogle(input: AiReviewInput, key: string): Promise<ReviewOutcome> {
      const image = await downloadPhoto(google.fetch, input.photoUrl);
      if (!image) return upstream('photo');

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
        logOwnerProblem('gemini', result.reason);
        return upstream(upstreamReason(result.reason));
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

      // A search that fails costs the account nothing: whatever happens next, the charge goes back.
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
        refund();
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
        releaseReview(ctx.db, account.id, photo);
        return c.json({ error: 'upstream', reason: outcome.reason }, 502);
      }
      return c.json({ review: outcome.review });
    });
  };
}
