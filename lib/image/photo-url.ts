/**
 * What a photo address may be, and what identifies it. No browser import: the background of the
 * extension and the Fripon Cloud server apply the very same rules.
 */

/** Photos are only fetched from Vinted's image CDN (`images1.vinted.net`...). */
export const ALLOWED_IMAGE_HOST_SUFFIX = '.vinted.net';

/** Longest side, in px, up to which a Vinted thumbnail (`/100x100/`, `/70x100/`) is too small to search. */
const TINY_THUMBNAIL_MAX_SIDE = 100;

const SIZE_SEGMENT_PATTERN = /^(\d+)x(\d+)$/;

/**
 * https, the default port and a `*.vinted.net` host: the background must not become a fetch
 * proxy for the page.
 */
export function isAllowedImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.hostname.toLowerCase().endsWith(ALLOWED_IMAGE_HOST_SUFFIX)
    );
  } catch {
    return false;
  }
}

/** Whether a Vinted image path carries a size segment too small to be worth searching. */
export function isTinyThumbnail(pathname: string): boolean {
  return pathname.split('/').some((segment) => {
    const size = SIZE_SEGMENT_PATTERN.exec(segment);
    return size !== null && Math.max(Number(size[1]), Number(size[2])) <= TINY_THUMBNAIL_MAX_SIDE;
  });
}

/**
 * What identifies a photo: its origin and path. Vinted adds a signature to the query string
 * (`?s=...`) that changes for the same picture. Throws on anything that is not a URL.
 */
export function photoKey(photoUrl: string): string {
  const url = new URL(photoUrl);
  return `${url.origin}${url.pathname}`;
}
