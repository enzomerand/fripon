import { GEMINI_MODEL, PROMPT_VERSION } from '../google/gemini';
import { photoKey } from '../image/photo-url';
import type { AiReviewInput } from './input';

/**
 * What identifies a cached review, without the storage: the key, and how long a review lives.
 * `review-cache.ts` keeps them in `storage.local`; the Fripon Cloud server keeps them in its own
 * database under the same digest, so one review answers both.
 */

/** `storage.local` key of a review: `fripon:ai:v1:<origin + path of the photo>:<digest>`. */
export const AI_CACHE_PREFIX = 'fripon:ai:v1:';
/** A review is reused for this long: the same listing reloaded costs nothing. */
export const AI_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** FNV-1a, 32 bits, as 8 hex digits: a short fingerprint, not a security measure. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * What was asked, as a short hash: the model and the prompt version (another model or another
 * question is another review), the title, the price and the fingerprint of the checks: a listing
 * whose price changed, or whose image search found something new, is reviewed again. Neither the
 * description nor the counts inside the signal lines are part of it: they move without changing
 * what there is to say, and each change would spend a credit for nothing.
 */
export function aiCacheDigest(input: AiReviewInput): string {
  return shortHash(
    JSON.stringify([GEMINI_MODEL, PROMPT_VERSION, input.title, input.price, input.fingerprint]),
  );
}

/**
 * The cache key of a review. The photo is identified by its origin and path (Vinted adds a
 * signature to the query string that changes for the same picture), what was asked by
 * `aiCacheDigest`.
 */
export function aiCacheKey(photoUrl: string, input: AiReviewInput): string {
  return `${AI_CACHE_PREFIX}${photoKey(photoUrl)}:${aiCacheDigest(input)}`;
}
