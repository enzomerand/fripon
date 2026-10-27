import { getUsage, refund, reserve } from '../credits';
import type { GeminiFailure, ReviewInput, ReviewResult } from '../google/gemini';
import { createFailureMemo } from '../google/failure-memo';
import { isAllowedImageUrl } from '../image/analyzer';
import { blobToBase64 } from '../image/base64';
import type { AiReviewResponse } from '../messages';
import { loadSettings } from '../settings';
import { clampReviewInput, type AiReviewInput } from './input';
import { aiCacheKey, readAiCache, writeAiCache } from './review-cache';

/** Everything the review does with the outside world, injected so it can be tested. */
interface AiReviewerDeps {
  /** Downloads the photo with the guards of the image analyzer (`fetchGuardedImage`). */
  fetchPhoto(url: string): Promise<Blob>;
  /** The paid call: one Gemini request. */
  reviewListing(input: ReviewInput, key: string): Promise<ReviewResult>;
  now?(): number;
}

const NETWORK_ERROR: AiReviewResponse = { status: 'error', reason: 'network' };

/** Gemini reads these image types; Vinted serves WEBP and JPEG. */
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/** The MIME type to announce for a downloaded photo (JPEG when the server said nothing usable). */
export function mimeTypeOf(blob: Blob): string {
  const type = (blob.type.split(';')[0] ?? '').trim().toLowerCase();
  return IMAGE_MIME_TYPES.has(type) ? type : 'image/jpeg';
}

/** What `createAiReviewer` returns: the `aiReview` handler, and a way to forget a failure. */
interface AiReviewer {
  /**
   * With `cacheOnly` nothing is ever spent: the answer is the cached review or `not_cached`. With
   * `retry` (the user clicked) a quota or a network failure remembered for a moment is tried
   * again instead of being answered from the memory.
   */
  (input: AiReviewInput, cacheOnly?: boolean, retry?: boolean): Promise<AiReviewResponse>;
  /** Forgets a remembered failure: the user just fixed something (their key tested fine). */
  forgetKeyFailure(): void;
}

/**
 * Builds the `aiReview` handler of the background. Same steps as the image search, cheapest first,
 * each one answering before the next costs anything:
 * 1. A review made in the last 7 days for the same photo and the same signals is answered from the
 *    cache, for free, even without a key.
 * 2. No key: `no_key`. A key that Google refused less than 10 minutes ago, or a quota, a network
 *    failure or an unavailable service less than 90 seconds ago: the same failure, without
 *    downloading the photo or calling Google again (`createFailureMemo`).
 * 3. The cap, checked without spending: `quota` when it is reached.
 * 4. The photo is downloaded (the browser's HTTP cache usually serves it).
 * 5. A Gemini credit is reserved right before the paid call, and given back only when Google
 *    certainly did not bill it (see `ReviewResult.refundable`).
 *
 * The same review asked twice at once is made once. Failures are never cached. The key and
 * Google's raw answer stay in here. The returned function never rejects.
 */
export function createAiReviewer(deps: AiReviewerDeps): AiReviewer {
  const now = deps.now ?? (() => Date.now());
  const inFlight = new Map<string, Promise<AiReviewResponse>>();
  const memo = createFailureMemo<GeminiFailure>(now);

  /** A cache that cannot be read is a cache that is empty: the review still works. */
  const cachedReview = (cacheKey: string) => readAiCache(cacheKey, now()).catch(() => null);

  async function run(
    input: AiReviewInput,
    cacheKey: string,
    retry: boolean,
  ): Promise<AiReviewResponse> {
    // Taken now: a failure that comes in after a success or a fixed key must not be remembered.
    const generation = memo.generation();
    const cached = await cachedReview(cacheKey);
    if (cached) return { status: 'ok', review: cached };

    const settings = await loadSettings();
    const key = settings.keys.gemini;
    if (key === '') return { status: 'no_key' };
    const remembered = memo.recall(key, retry);
    if (remembered) return { status: 'error', reason: remembered };
    // The cap comes from the stored settings, not from any gate a page was shown earlier. Only
    // looked at here: the credit is taken later, right before the call.
    if ((await getUsage('gemini', settings.caps.gemini)).state === 'reached') {
      return { status: 'quota' };
    }

    let photo: ReviewInput['photo'];
    try {
      const blob = await deps.fetchPhoto(input.photoUrl);
      photo = { mimeType: mimeTypeOf(blob), base64: await blobToBase64(blob) };
    } catch {
      return { status: 'error', reason: 'photo' };
    }

    // Two reviews can pass the check above for the last credit: only one gets it.
    const reservation = await reserve('gemini', 1, settings.caps.gemini);
    if (!reservation.ok) return { status: 'quota' };

    let result: ReviewResult;
    try {
      result = await deps.reviewListing(
        {
          photo,
          title: input.title,
          description: input.description,
          price: input.price,
          signals: input.signals,
        },
        key,
      );
    } catch {
      result = { ok: false, reason: 'network', refundable: false };
    }
    if (!result.ok) {
      // Only a call Google certainly did not bill gives its credit back: after a timeout or a
      // 5xx the photo may have been processed, and the counter must not understate the spend.
      if (result.refundable) await refund('gemini', 1, reservation.periodId).catch(() => undefined);
      // An unrecognised 400 may be about this very photo: the next listing deserves its own try.
      if (!result.specific) memo.remember(key, result.reason, generation);
      return { status: 'error', reason: result.reason };
    }

    memo.forget();
    // The review was paid for: a cache that cannot be written must not hide it.
    await writeAiCache(cacheKey, result.review, now()).catch(() => undefined);
    return { status: 'ok', review: result.review };
  }

  function aiReview(
    rawInput: AiReviewInput,
    cacheOnly = false,
    retry = false,
  ): Promise<AiReviewResponse> {
    // Validated first: a refused URL never reaches the cache, the settings or the network.
    if (!isAllowedImageUrl(rawInput.photoUrl)) {
      return Promise.resolve({ status: 'error', reason: 'photo' });
    }

    const input = clampReviewInput(rawInput);
    const cacheKey = aiCacheKey(input.photoUrl, input);
    if (cacheOnly) {
      return cachedReview(cacheKey).then((cached): AiReviewResponse =>
        cached ? { status: 'ok', review: cached } : { status: 'not_cached' },
      );
    }

    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    const review = run(input, cacheKey, retry)
      .catch((): AiReviewResponse => NETWORK_ERROR)
      .finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, review);
    return review;
  }

  return Object.assign(aiReview, {
    forgetKeyFailure() {
      memo.forget();
    },
  });
}
