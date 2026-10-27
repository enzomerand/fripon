import { parseReview } from '../google/gemini';
import { isRecord } from '../json';
import type { AiReview } from '../model';
import { createTtlCache } from '../ttl-cache';
import { AI_CACHE_PREFIX, AI_CACHE_TTL_MS, aiCacheKey } from './review-key';

// The key and the lifetime are shared with the Fripon Cloud server: they live in `review-key.ts`
// (no browser import) and are exported from here as before.
export { AI_CACHE_PREFIX, AI_CACHE_TTL_MS, aiCacheKey };

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
