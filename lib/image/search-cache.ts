import { isRecord } from '../json';
import type { ImageMatch } from '../model';
import { createTtlCache } from '../ttl-cache';

/**
 * `storage.local` key of a search: `fripon:vision:v1:<origin + path of the photo>`.
 *
 * Lot 3b adds the original price to each match: it must bump this to `v2` at the same time.
 * Entries written by `v1` hold `price: null` for 7 days, and would hide the prices of every photo
 * already searched. The old `v1` entries are inert once nothing reads them.
 */
export const VISION_CACHE_PREFIX = 'fripon:vision:v1:';
/** A result is reused for this long: the same listing reloaded costs nothing. */
export const VISION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

/**
 * The cache key of a photo. Vinted adds a signature to the query string (`?s=...`) that changes
 * for the same picture: only the origin and the path identify it.
 */
export function visionCacheKey(photoUrl: string): string {
  const url = new URL(photoUrl);
  return `${VISION_CACHE_PREFIX}${url.origin}${url.pathname}`;
}

function parseMatch(value: unknown): ImageMatch | undefined {
  if (!isRecord(value)) return undefined;
  const { platform, url, exact, price } = value;
  if (typeof platform !== 'string' || typeof url !== 'string' || typeof exact !== 'boolean') {
    return undefined;
  }
  // The URL ends up in a link of the card. Prices come with lot 3b (and a new cache key): until
  // then a stored price is not something this version wrote.
  if (!/^https?:\/\//i.test(url) || price !== null) return undefined;
  return { platform, url, exact, price: null };
}

/** null for anything that does not look like what `writeVisionCache` stores. */
function parseEntry(value: unknown): CacheEntry | null {
  if (!isRecord(value) || !Array.isArray(value.matches)) return null;
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  const matches = value.matches.map(parseMatch);
  // One damaged match makes the whole entry untrustworthy: search again.
  if (matches.some((match) => match === undefined)) return null;
  return { matches: matches as ImageMatch[], at: value.at };
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
