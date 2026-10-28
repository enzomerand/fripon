import { isRecord } from '../json';
import type { ImageMatch } from '../model';
import { createTtlCache } from '../ttl-cache';
import {
  VISION_CACHE_PREFIX,
  VISION_CACHE_TTL_MS,
  parseMatches,
  visionCacheKey,
} from './search-entry';

// The key, the lifetime and the shape of an entry are shared with the Fripon Cloud server: they
// live in `search-entry.ts` (no browser import) and are exported from here as before.
export { VISION_CACHE_PREFIX, VISION_CACHE_TTL_MS, visionCacheKey };

/** The cache never keeps more entries than this (the oldest go first). */
export const VISION_CACHE_MAX_ENTRIES = 200;
/** Name of the lock that serialises the cache writes. */
const VISION_CACHE_LOCK = 'fripon:vision-cache';

/** What is stored: the matches only, never Google's raw answer. */
interface CacheEntry {
  matches: ImageMatch[];
  /** When the search was made (ms since the epoch). */
  at: number;
}

/** null for anything that does not look like what `writeVisionCache` stores. */
function parseEntry(value: unknown): CacheEntry | null {
  if (!isRecord(value) || !Array.isArray(value.matches)) return null;
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  const matches = parseMatches(value.matches);
  return matches ? { matches, at: value.at } : null;
}

const cache = createTtlCache<CacheEntry>({
  prefix: VISION_CACHE_PREFIX,
  ttlMs: VISION_CACHE_TTL_MS,
  maxEntries: VISION_CACHE_MAX_ENTRIES,
  lockName: VISION_CACHE_LOCK,
  parse: parseEntry,
});

/** The matches stored for `key`, null when there are none, they expired, or they are damaged. */
export async function readVisionCache(key: string, now: number): Promise<ImageMatch[] | null> {
  return (await cache.read(key, now))?.matches ?? null;
}

/** Stores the matches of a search, then keeps the cache within its limits. */
export function writeVisionCache(key: string, matches: ImageMatch[], now: number): Promise<void> {
  return cache.write(key, { matches, at: now });
}
