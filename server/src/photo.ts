import type { FetchLike } from '../../lib/fetch';
import { blobToBase64 } from '../../lib/image/base64';
import { fetchGuardedImage, mimeTypeOf } from '../../lib/image/guarded-fetch';
import { isAllowedImageUrl, isTinyThumbnail } from '../../lib/image/photo-url';

export { serverPhotoKey } from './photo-key';

/**
 * A photo address the server accepts: the extension's allowlist (https, the default port,
 * `*.vinted.net`) minus the thumbnails too small to be worth a paid search. Checked before
 * anything is reserved or fetched, on the URL as it came: the size segment is dropped from the
 * photo's KEY only (`serverPhotoKey`), after this check.
 */
export function isAcceptablePhotoUrl(raw: string): boolean {
  return isAllowedImageUrl(raw) && !isTinyThumbnail(new URL(raw).pathname);
}

export interface Photo {
  base64: string;
  mimeType: string;
}

/**
 * Downloads a photo for a Google call, or null when it cannot be used. The download is the
 * extension's own guarded one (allowlisted host, no redirect followed, no cookies, 10 s, 8 MB, the
 * final host checked again), and the server asks for one more thing: the answer must be an image.
 * Never throws: whatever went wrong, the photo is simply not usable.
 */
export async function downloadPhoto(fetchImpl: FetchLike, url: string): Promise<Photo | null> {
  try {
    const blob = await fetchGuardedImage(fetchImpl, url);
    const type = (blob.type.split(';')[0] ?? '').trim().toLowerCase();
    if (!type.startsWith('image/')) return null;
    return { base64: await blobToBase64(blob), mimeType: mimeTypeOf(blob) };
  } catch {
    return null;
  }
}
