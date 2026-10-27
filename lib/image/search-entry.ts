import { isRecord } from '../json';
import type { ImageMatch } from '../model';
import { photoKey } from './photo-url';

/**
 * What a cached image search looks like, without the storage: the key of a photo, how long an
 * answer lives, and how a stored list of matches is read back. `search-cache.ts` keeps them in
 * `storage.local`; the Fripon Cloud server keeps them in its own database, so both read and write
 * exactly the same thing.
 */

/**
 * `storage.local` key of a search: `fripon:vision:v1:<origin + path of the photo>`.
 *
 * Matches carry no price: the original price cannot be read (Shein and Temu serve their prices
 * to browsers only, see the design doc, section 10). If prices are ever added to the matches, bump
 * this to `v2` at the same time: entries written by `v1` hold `price: null` for 7 days, and would
 * hide the prices of every photo already searched. The old `v1` entries are inert once nothing
 * reads them.
 */
export const VISION_CACHE_PREFIX = 'fripon:vision:v1:';
/** A result is reused for this long: the same listing reloaded costs nothing. */
export const VISION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The cache key of a photo. Vinted adds a signature to the query string (`?s=...`) that changes
 * for the same picture: only the origin and the path identify it.
 *
 * KNOWN LIMIT, left as is for now: the path also carries the size segment (`/310x430/` for a grid
 * thumbnail, `/f800/` for the photo of the item page). The same picture searched from a results
 * grid and from its item page therefore has two keys and is paid twice. Unifying them (keeping the
 * photo's id and dropping the size) is only safe if Vision answers the same for the same picture at
 * both sizes, and if the id in the path is the same for both: not checked yet.
 */
export function visionCacheKey(photoUrl: string): string {
  return `${VISION_CACHE_PREFIX}${photoKey(photoUrl)}`;
}

function parseMatch(value: unknown): ImageMatch | undefined {
  if (!isRecord(value)) return undefined;
  const { platform, url, exact, price } = value;
  if (typeof platform !== 'string' || typeof url !== 'string' || typeof exact !== 'boolean') {
    return undefined;
  }
  // The URL ends up in a link of the card. This version never writes a price: a stored one is not
  // something it wrote.
  if (!/^https?:\/\//i.test(url) || price !== null) return undefined;
  return { platform, url, exact, price: null };
}

/**
 * The matches a stored list holds, null for anything that is not a list of what a search writes.
 * One damaged match makes the whole list untrustworthy: search again.
 */
export function parseMatches(value: unknown): ImageMatch[] | null {
  if (!Array.isArray(value)) return null;
  const matches = value.map(parseMatch);
  return matches.some((match) => match === undefined) ? null : (matches as ImageMatch[]);
}
