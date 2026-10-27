import { GEMINI_MODEL, PROMPT_VERSION, parseReview } from '../google/gemini';
import { isRecord } from '../json';
import type { AiReview } from '../model';
import { createTtlCache } from '../ttl-cache';
import type { AiReviewInput } from './input';

/** `storage.local` key of a review: `fripon:ai:v1:<origin + path of the photo>:<digest>`. */
export const AI_CACHE_PREFIX = 'fripon:ai:v1:';
/** A review is reused for this long: the same listing reloaded costs nothing. */
export const AI_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The cache never keeps more entries than this (the oldest go first). */
export const AI_CACHE_MAX_ENTRIES = 200;
/** Name of the lock that serialises the cache writes. */
const AI_CACHE_LOCK = 'fripon:ai-cache';

/** What is stored: the review only, never Google's raw answer. */
interface CacheEntry {
  review: AiReview;
  /** When the review was made (ms since the epoch). */
  at: number;
}

/** FNV-1a, 32 bits, as 8 hex digits: a short fingerprint, not a security measure. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The cache key of a review. The photo is identified by its origin and path (Vinted adds a
 * signature to the query string that changes for the same picture). What was asked is identified
 * by a hash of the model and the prompt version (another model or another question is another
 * review), the title, the price and the fingerprint of the checks: a listing whose price changed,
 * or whose image search found something new, is reviewed again. Neither the description nor the
 * counts inside the signal lines are part of it: they move without changing what there is to say,
 * and each change would spend a credit for nothing.
 */
export function aiCacheKey(photoUrl: string, input: AiReviewInput): string {
  const url = new URL(photoUrl);
  const digest = shortHash(
    JSON.stringify([GEMINI_MODEL, PROMPT_VERSION, input.title, input.price, input.fingerprint]),
  );
  return `${AI_CACHE_PREFIX}${url.origin}${url.pathname}:${digest}`;
}

/** null for anything that does not look like what `writeAiCache` stores. */
function parseEntry(value: unknown): CacheEntry | null {
  if (!isRecord(value) || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  const review = parseReview(value.review);
  return review ? { review, at: value.at } : null;
}

const cache = createTtlCache<CacheEntry>({
  prefix: AI_CACHE_PREFIX,
  ttlMs: AI_CACHE_TTL_MS,
  maxEntries: AI_CACHE_MAX_ENTRIES,
  lockName: AI_CACHE_LOCK,
  parse: parseEntry,
});

/** The review stored for `key`, null when there is none, it expired, or it is damaged. */
export async function readAiCache(key: string, now: number): Promise<AiReview | null> {
  return (await cache.read(key, now))?.review ?? null;
}

/** Stores a review, then keeps the cache within its limits. */
export function writeAiCache(key: string, review: AiReview, now: number): Promise<void> {
  return cache.write(key, { review, at: now });
}
