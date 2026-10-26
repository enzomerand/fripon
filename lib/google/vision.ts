import { isRecord } from '../json';
import {
  classify,
  classifyKnown,
  errorInfoOf,
  isHeaderSafe,
  readError,
  type KeyCheckFailure,
} from './key-check';

/** A Vision call that takes longer than this (answer body included) counts as a network failure. */
export const VISION_TIMEOUT_MS = 20_000;
/** Results asked for per detection type; the free checks only need the pages, 30 is plenty. */
export const VISION_MAX_RESULTS = 30;
export const VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';

/** Same words as a key check: why Google refused (see `KeyCheckFailure`). */
export type VisionFailure = KeyCheckFailure;

interface WebImage {
  url?: string;
}

/** A page where Google found the photo (or a piece of it). Every field may be missing. */
export interface WebPage {
  url?: string;
  pageTitle?: string;
  fullMatchingImages?: WebImage[];
  partialMatchingImages?: WebImage[];
}

/** The part of Vision's `webDetection` Fripon reads. The rest of the answer is dropped. */
export interface WebDetection {
  pagesWithMatchingImages?: WebPage[];
  fullMatchingImages?: WebImage[];
  partialMatchingImages?: WebImage[];
}

export type WebDetectResult =
  { ok: true; webDetection: WebDetection } | { ok: false; reason: VisionFailure };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** gRPC codes of a per-image error (`google.rpc.Status`) that need a word of their own. */
const GRPC_RESOURCE_EXHAUSTED = 8;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_UNAUTHENTICATED = 16;

/**
 * The failure of one image inside a 200 answer. Billing, API and key problems are named by
 * Google's reasons; anything else (bad image data...) is not the key's fault, so it counts as a
 * failed attempt that may be retried.
 */
function perImageFailure(error: unknown): VisionFailure {
  const info = errorInfoOf(error);
  const code = isRecord(error) && typeof error.code === 'number' ? error.code : 0;
  if (code === GRPC_RESOURCE_EXHAUSTED && info.status === '') info.status = 'RESOURCE_EXHAUSTED';
  const known = classifyKnown(0, info);
  if (known) return known;
  return code === GRPC_PERMISSION_DENIED || code === GRPC_UNAUTHENTICATED ? 'invalid' : 'network';
}

/**
 * Keeps the objects of a list that are records, dropping whatever else Google (or a proxy) put
 * there. The values inside are read defensively by the caller.
 */
function recordList(value: unknown): Array<Record<string, unknown>> | undefined {
  return Array.isArray(value) ? value.filter(isRecord) : undefined;
}

function sanitizePage(page: Record<string, unknown>): WebPage {
  const clean: WebPage = {};
  if (typeof page.url === 'string') clean.url = page.url;
  if (typeof page.pageTitle === 'string') clean.pageTitle = page.pageTitle;
  const full = recordList(page.fullMatchingImages);
  if (full) clean.fullMatchingImages = full.map(sanitizeImage);
  const partial = recordList(page.partialMatchingImages);
  if (partial) clean.partialMatchingImages = partial.map(sanitizeImage);
  return clean;
}

function sanitizeImage(image: Record<string, unknown>): WebImage {
  return typeof image.url === 'string' ? { url: image.url } : {};
}

/** Only the fields Fripon reads, each checked: the answer is untrusted data. */
function sanitizeWebDetection(value: unknown): WebDetection {
  if (!isRecord(value)) return {};
  const clean: WebDetection = {};
  const pages = recordList(value.pagesWithMatchingImages);
  if (pages) clean.pagesWithMatchingImages = pages.map(sanitizePage);
  const full = recordList(value.fullMatchingImages);
  if (full) clean.fullMatchingImages = full.map(sanitizeImage);
  const partial = recordList(value.partialMatchingImages);
  if (partial) clean.partialMatchingImages = partial.map(sanitizeImage);
  return clean;
}

/**
 * Asks Google Vision (WEB_DETECTION) where a photo appears on the web. This is the paid call:
 * 1 image = 1 billed unit, so the caller must have reserved a credit first. The key travels in
 * the `x-goog-api-key` header, never in the URL (URLs end up in logs and history).
 *
 * @param base64 the image bytes, base64 encoded (JPEG and WEBP both work).
 */
export async function webDetect(
  base64: string,
  key: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<WebDetectResult> {
  if (!isHeaderSafe(key)) return { ok: false, reason: 'invalid' };

  const controller = new AbortController();
  // Covers the whole exchange, body included.
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const response = await fetchImpl(VISION_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64 },
            features: [{ type: 'WEB_DETECTION', maxResults: VISION_MAX_RESULTS }],
          },
        ],
      }),
      credentials: 'omit',
      signal: controller.signal,
    });
    // Google having a bad moment says nothing about the key.
    if (response.status >= 500) return { ok: false, reason: 'network' };
    if (!response.ok)
      return { ok: false, reason: classify(response.status, await readError(response)) };

    const body: unknown = await response.json();
    const first = isRecord(body) && Array.isArray(body.responses) ? body.responses[0] : undefined;
    if (!isRecord(first)) return { ok: false, reason: 'network' };
    // The call went through but this image failed: no result, and nothing to bill.
    if (first.error !== undefined && first.error !== null) {
      return { ok: false, reason: perImageFailure(first.error) };
    }
    // A photo with no match at all comes back without `webDetection`.
    return { ok: true, webDetection: sanitizeWebDetection(first.webDetection) };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
