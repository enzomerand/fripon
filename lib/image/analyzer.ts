import type { AnalyzeImageResponse } from '../messages';

/** Photos are only fetched from Vinted's image CDN (`images1.vinted.net`...). */
export const ALLOWED_IMAGE_HOST_SUFFIX = '.vinted.net';
/** A photo that takes longer than this to download is abandoned. */
export const IMAGE_FETCH_TIMEOUT_MS = 10_000;
/** A photo bigger than this is refused before it is decoded. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Results kept in memory, oldest evicted first. */
export const IMAGE_CACHE_MAX_ENTRIES = 500;

export interface PixelResult {
  /** 64-bit difference hash as 16 lowercase hex digits. */
  hash: string;
  catalogScore: number;
}

export interface ImageAnalyzerDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Decodes the image and computes its hash and catalogue score. */
  computePixels(blob: Blob): Promise<PixelResult>;
}

/** https and a `*.vinted.net` host: the background must not become a fetch proxy for the page. */
export function isAllowedImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hostname.toLowerCase().endsWith(ALLOWED_IMAGE_HOST_SUFFIX)
    );
  } catch {
    return false;
  }
}

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
  const chunks: BlobPart[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > IMAGE_MAX_BYTES) {
      await reader.cancel();
      throw new Error('Image too large');
    }
    chunks.push(value as BlobPart);
  }
  return new Blob(chunks, { type });
}

/**
 * Builds the `analyzeImage` handler of the background. Results are cached by URL; the in-flight
 * promise is cached too, so the same photo asked twice at once is downloaded once. Failures are
 * never cached, so a later request can retry. The returned function never rejects.
 */
export function createImageAnalyzer(
  deps: ImageAnalyzerDeps,
): (url: string) => Promise<AnalyzeImageResponse> {
  const cache = new Map<string, Promise<AnalyzeImageResponse>>();

  async function run(url: string): Promise<AnalyzeImageResponse> {
    const response = await deps.fetch(url, {
      // A redirect could lead anywhere: refuse it rather than follow it.
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (response.url && !isAllowedImageUrl(response.url)) throw new Error('Unexpected image host');
    const pixels = await deps.computePixels(await readLimited(response));
    return { ok: true, hash: pixels.hash, catalogScore: pixels.catalogScore };
  }

  return function analyzeImage(url) {
    // Validated before the cache lookup: a refused URL never reaches the cache or the network.
    if (!isAllowedImageUrl(url)) return Promise.resolve({ ok: false, error: 'URL not allowed' });

    const cached = cache.get(url);
    if (cached) return cached;

    const pending = run(url).catch((error: unknown): AnalyzeImageResponse => ({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    if (cache.size >= IMAGE_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(url, pending);
    void pending.then((result) => {
      if (!result.ok && cache.get(url) === pending) cache.delete(url);
    });
    return pending;
  };
}
