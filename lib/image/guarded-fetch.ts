import type { FetchLike } from '../fetch';
import { isAllowedImageUrl } from './photo-url';

/** A photo that takes longer than this to download is abandoned. */
export const IMAGE_FETCH_TIMEOUT_MS = 10_000;
/** A photo bigger than this is refused before it is decoded. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** What `new Blob` takes, spelled without the DOM's `BlobPart` (the server type-checks this file without the DOM lib). */
type BlobParts = NonNullable<ConstructorParameters<typeof Blob>[0]>;

/** Reads the body, giving up as soon as it grows past `IMAGE_MAX_BYTES`. */
async function readLimited(response: Response): Promise<Blob> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) throw new Error('Image too large');

  const type = response.headers.get('content-type') ?? '';
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > IMAGE_MAX_BYTES) throw new Error('Image too large');
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: BlobParts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > IMAGE_MAX_BYTES) {
      await reader.cancel();
      throw new Error('Image too large');
    }
    chunks.push(value as BlobParts[number]);
  }
  return new Blob(chunks, { type });
}

/**
 * Downloads a Vinted photo with every guard: an allowed URL, no redirect, no cookies, a timeout,
 * a final host that is still the CDN and a size limit. Everything the background fetches from
 * the page's request goes through here.
 */
export async function fetchGuardedImage(fetchImpl: FetchLike, url: string): Promise<Blob> {
  if (!isAllowedImageUrl(url)) throw new Error('URL not allowed');
  const response = await fetchImpl(url, {
    // A redirect could lead anywhere: refuse it rather than follow it.
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.url && !isAllowedImageUrl(response.url)) throw new Error('Unexpected image host');
  return readLimited(response);
}

/** Gemini reads these image types; Vinted serves WEBP and JPEG. */
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/** The MIME type to announce for a downloaded photo (JPEG when the server said nothing usable). */
export function mimeTypeOf(blob: Blob): string {
  const type = (blob.type.split(';')[0] ?? '').trim().toLowerCase();
  return IMAGE_MIME_TYPES.has(type) ? type : 'image/jpeg';
}
