import { dHash, catalogScore, hashToHex } from '../lib/image/pixels';
import { isRuntimeMessage, type AnalyzeImageResponse } from '../lib/messages';

/** Photos are shrunk to this many pixels on their longest side before analysis. */
const MAX_ANALYSIS_SIDE = 256;
/** Results kept in memory, oldest evicted first. */
const CACHE_MAX_ENTRIES = 500;

const cache = new Map<string, AnalyzeImageResponse & { ok: true }>();

async function fetchPixels(
  url: string,
): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const scale = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const context = new OffscreenCanvas(w, h).getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(bitmap, 0, 0, w, h);
    return { data: context.getImageData(0, 0, w, h).data, w, h };
  } finally {
    bitmap.close();
  }
}

async function analyzeImage(url: string): Promise<AnalyzeImageResponse> {
  const cached = cache.get(url);
  if (cached) return cached;
  try {
    if (new URL(url).protocol !== 'https:')
      return { ok: false, error: 'Only https URLs are allowed' };
    const { data, w, h } = await fetchPixels(url);
    const result = {
      ok: true as const,
      hash: hashToHex(dHash(data, w, h)),
      catalogScore: catalogScore(data, w, h),
    };
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(url, result);
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Only our own content scripts and pages may use the background's host permissions.
    if (sender.id !== browser.runtime.id || !isRuntimeMessage(message)) return false;
    void analyzeImage(message.url).then(sendResponse);
    return true;
  });
});
