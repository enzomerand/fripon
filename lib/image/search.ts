import { parseWebDetection } from '../checks/image-matches';
import type { WebDetectResult } from '../google/vision';
import { reserve, refund } from '../credits';
import type { SearchImageResponse } from '../messages';
import { loadSettings } from '../settings';
import { isAllowedImageUrl } from './analyzer';
import { readVisionCache, visionCacheKey, writeVisionCache } from './search-cache';

/** Everything the search does with the outside world, injected so it can be tested. */
export interface ImageSearcherDeps {
  /** Downloads the photo with the guards of the image analyzer (`fetchGuardedImage`). */
  fetchPhoto(url: string): Promise<Blob>;
  /** The paid call: one Vision unit. */
  webDetect(base64: string, key: string): Promise<WebDetectResult>;
  now?(): number;
}

/** Characters turned into a binary string at once: `fromCharCode` chokes on very long argument lists. */
const BASE64_CHUNK = 0x8000;

/** Base64 of some bytes, with no `Buffer` (the service worker has none). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

const NETWORK_ERROR: SearchImageResponse = { status: 'error', reason: 'network' };

/**
 * Builds the `searchImage` handler of the background: finds where a listing photo is sold.
 *
 * - A search made in the last 7 days is answered from the cache, for free, even without a key.
 * - The same photo asked twice at once is searched once.
 * - A Vision credit is reserved right before the paid call and given back only when Google
 *   certainly did not bill it (see `WebDetectResult.refundable`). Failures are never cached.
 *
 * The key and Google's raw answer stay in here. The returned function never rejects.
 */
export function createImageSearcher(
  deps: ImageSearcherDeps,
): (photoUrl: string) => Promise<SearchImageResponse> {
  const now = deps.now ?? (() => Date.now());
  const inFlight = new Map<string, Promise<SearchImageResponse>>();

  async function run(photoUrl: string, cacheKey: string): Promise<SearchImageResponse> {
    // A cache that cannot be read is a cache that is empty: the search still works.
    const cached = await readVisionCache(cacheKey, now()).catch(() => null);
    if (cached) return { status: 'ok', matches: cached };

    const settings = await loadSettings();
    const key = settings.keys.vision;
    if (key === '') return { status: 'no_key' };

    // Downloaded before the credit is reserved: a Vinted CDN failure never touches the counter.
    let image: string;
    try {
      image = bytesToBase64(new Uint8Array(await (await deps.fetchPhoto(photoUrl)).arrayBuffer()));
    } catch {
      return { status: 'error', reason: 'photo' };
    }

    // The cap comes from the stored settings, not from any gate a page was shown earlier.
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
      return { status: 'error', reason: result.reason };
    }

    const matches = parseWebDetection(result.webDetection);
    // The search was paid for: a cache that cannot be written must not hide its result.
    await writeVisionCache(cacheKey, matches, now()).catch(() => undefined);
    return { status: 'ok', matches };
  }

  return function searchImage(photoUrl) {
    // Validated first: a refused URL never reaches the cache, the settings or the network.
    if (!isAllowedImageUrl(photoUrl)) return Promise.resolve({ status: 'error', reason: 'photo' });

    const cacheKey = visionCacheKey(photoUrl);
    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    const search = run(photoUrl, cacheKey)
      .catch((): SearchImageResponse => NETWORK_ERROR)
      .finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, search);
    return search;
  };
}
