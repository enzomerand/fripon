import { parseWebDetection } from '../checks/image-matches';
import { getUsage, refund, reserve } from '../credits';
import { isKeyFailure } from '../google/refusal';
import type { VisionFailure, WebDetectResult } from '../google/vision';
import type { SearchImageResponse } from '../messages';
import { loadSettings } from '../settings';
import { isAllowedImageUrl } from './analyzer';
import { blobToBase64 } from './base64';
import { readVisionCache, visionCacheKey, writeVisionCache } from './search-cache';

/** Everything the search does with the outside world, injected so it can be tested. */
interface ImageSearcherDeps {
  /** Downloads the photo with the guards of the image analyzer (`fetchGuardedImage`). */
  fetchPhoto(url: string): Promise<Blob>;
  /** The paid call: one Vision unit. */
  webDetect(base64: string, key: string): Promise<WebDetectResult>;
  now?(): number;
}

const NETWORK_ERROR: SearchImageResponse = { status: 'error', reason: 'network' };

/** A key Google refused is remembered this long: further listings do not retry it. */
export const KEY_FAILURE_MEMO_MS = 10 * 60 * 1000;

/** What `createImageSearcher` returns: the `searchImage` handler, and a way to forget a refused key. */
interface ImageSearcher {
  /** With `cacheOnly` nothing is ever spent: the answer is the cached result or `not_cached`. */
  (photoUrl: string, cacheOnly?: boolean): Promise<SearchImageResponse>;
  /** Forgets a remembered key failure: the user just fixed something (their key tested fine). */
  forgetKeyFailure(): void;
}

/**
 * Builds the `searchImage` handler of the background: finds where a listing photo is sold.
 *
 * The steps, cheapest first, each one answering before the next costs anything:
 * 1. A search made in the last 7 days is answered from the cache, for free, even without a key.
 * 2. No key: `no_key`. A key that Google refused less than 10 minutes ago: the same refusal,
 *    without downloading the photo or calling Google again.
 * 3. The cap, checked without spending: `quota` when it is reached.
 * 4. The photo is downloaded. The analyzer keeps only the hash of the photos it fetched, not their
 *    bytes, so this is a second download of the main photo (the browser's HTTP cache usually
 *    serves it): not worth sharing the bytes between the two.
 * 5. A Vision credit is reserved right before the paid call, and given back only when Google
 *    certainly did not bill it (see `WebDetectResult.refundable`).
 *
 * The same photo asked twice at once is searched once. Failures are never cached. The key and
 * Google's raw answer stay in here. The returned function never rejects.
 */
export function createImageSearcher(deps: ImageSearcherDeps): ImageSearcher {
  const now = deps.now ?? (() => Date.now());
  const inFlight = new Map<string, Promise<SearchImageResponse>>();
  /** In memory only: a restarted service worker simply tries the key again. */
  let keyFailure: { key: string; reason: VisionFailure; until: number } | null = null;

  /** A cache that cannot be read is a cache that is empty: the search still works. */
  const cachedMatches = (cacheKey: string) => readVisionCache(cacheKey, now()).catch(() => null);

  async function run(photoUrl: string, cacheKey: string): Promise<SearchImageResponse> {
    const cached = await cachedMatches(cacheKey);
    if (cached) return { status: 'ok', matches: cached };

    const settings = await loadSettings();
    const key = settings.keys.vision;
    if (key === '') return { status: 'no_key' };
    // Remembered for this very key only: saving another one tries again at once.
    if (keyFailure && keyFailure.key === key && now() < keyFailure.until) {
      return { status: 'error', reason: keyFailure.reason };
    }
    // The cap comes from the stored settings, not from any gate a page was shown earlier. Only
    // looked at here: the credit is taken later, right before the call.
    if ((await getUsage('vision', settings.caps.vision)).state === 'reached') {
      return { status: 'quota' };
    }

    let image: string;
    try {
      image = await blobToBase64(await deps.fetchPhoto(photoUrl));
    } catch {
      return { status: 'error', reason: 'photo' };
    }

    // Two searches can pass the check above for the last credit: only one gets it.
    const reservation = await reserve('vision', 1, settings.caps.vision);
    if (!reservation.ok) return { status: 'quota' };

    let result: WebDetectResult;
    try {
      result = await deps.webDetect(image, key);
    } catch {
      result = { ok: false, reason: 'network', refundable: false };
    }
    if (!result.ok) {
      // Only a call Google certainly did not bill gives its credit back: after a timeout or a
      // 5xx the image may have been processed, and the counter must not understate the spend.
      if (result.refundable) await refund('vision', 1, reservation.periodId).catch(() => undefined);
      if (isKeyFailure(result.reason)) {
        keyFailure = { key, reason: result.reason, until: now() + KEY_FAILURE_MEMO_MS };
      }
      return { status: 'error', reason: result.reason };
    }

    keyFailure = null;
    const matches = parseWebDetection(result.webDetection);
    // The search was paid for: a cache that cannot be written must not hide its result.
    await writeVisionCache(cacheKey, matches, now()).catch(() => undefined);
    return { status: 'ok', matches };
  }

  function searchImage(photoUrl: string, cacheOnly = false): Promise<SearchImageResponse> {
    // Validated first: a refused URL never reaches the cache, the settings or the network.
    if (!isAllowedImageUrl(photoUrl)) return Promise.resolve({ status: 'error', reason: 'photo' });

    const cacheKey = visionCacheKey(photoUrl);
    if (cacheOnly) {
      return cachedMatches(cacheKey).then((cached): SearchImageResponse =>
        cached ? { status: 'ok', matches: cached } : { status: 'not_cached' },
      );
    }

    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    const search = run(photoUrl, cacheKey)
      .catch((): SearchImageResponse => NETWORK_ERROR)
      .finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, search);
    return search;
  }

  return Object.assign(searchImage, {
    forgetKeyFailure() {
      keyFailure = null;
    },
  });
}
