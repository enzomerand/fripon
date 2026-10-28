import type { FetchLike } from '../fetch';
import type { AnalyzeImageResponse } from '../messages';
import { fetchGuardedImage } from './guarded-fetch';
import { isAllowedImageUrl } from './photo-url';

// The pure part (what a photo address may be, the guarded download) lives in its own files so the
// Fripon Cloud server can import it; the background keeps reading it from here.
export { IMAGE_FETCH_TIMEOUT_MS, IMAGE_MAX_BYTES, fetchGuardedImage } from './guarded-fetch';
export { ALLOWED_IMAGE_HOST_SUFFIX, isAllowedImageUrl } from './photo-url';

/** Results kept in memory, oldest evicted first. */
export const IMAGE_CACHE_MAX_ENTRIES = 500;

export interface PixelResult {
  /** 64-bit difference hash as 16 lowercase hex digits. */
  hash: string;
  catalogScore: number;
}

export interface ImageAnalyzerDeps {
  fetch: FetchLike;
  /** Decodes the image and computes its hash and catalogue score. */
  computePixels(blob: Blob): Promise<PixelResult>;
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
    const pixels = await deps.computePixels(await fetchGuardedImage(deps.fetch, url));
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
