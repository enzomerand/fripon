/**
 * What identifies a photo on the server: its origin and path, without the size segment of a
 * Vinted image path. Vinted serves one picture at several sizes (`/f800/` on the item page,
 * `/310x430/` in a result grid), and the same listing seen in the grid then on its page must cost
 * one analysis, not two. No import on purpose: the database migrations use it too.
 */

/** A size directory of a Vinted image path: `f800`, `f1200`, `310x430`, `1200x1200`... */
const SIZE_SEGMENT = /^(?:f\d+|\d+x\d+)$/;

/**
 * The key (`origin + path`) with every size directory dropped. The last segment is the file name
 * and is never touched. A key that is not a path (or has no size segment) comes back unchanged.
 */
export function dropSizeSegment(key: string): string {
  const slash = key.indexOf('/', key.indexOf('//') + 2);
  if (slash < 0) return key;
  const origin = key.slice(0, slash);
  const segments = key.slice(slash).split('/');
  const last = segments.length - 1;
  return (
    origin + segments.filter((segment, i) => i === last || !SIZE_SEGMENT.test(segment)).join('/')
  );
}

/** The key of a photo URL (see `dropSizeSegment`). The query string never counts: Vinted signs it. Throws on anything that is not a URL. */
export function serverPhotoKey(photoUrl: string): string {
  const url = new URL(photoUrl);
  return dropSizeSegment(`${url.origin}${url.pathname}`);
}
