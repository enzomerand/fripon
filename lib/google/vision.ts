import { isRecord } from '../json';
import {
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

/**
 * Why a search failed: the words of a key check (see `KeyCheckFailure`), or `photo` when the
 * problem is the image itself (Google could not read it, or it is too big).
 */
export type VisionFailure = KeyCheckFailure | 'photo';

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
  | { ok: true; webDetection: WebDetection }
  | {
      ok: false;
      reason: VisionFailure;
      /**
       * true only when Google certainly did not bill the call: it was never sent, or Google
       * answered 400, 403 or 429 with a refusal it names (invalid key, API blocked or disabled,
       * billing off, quota). Anything else (a timeout, a 5xx, an unreadable answer, an error on
       * the image) may have been processed, so the credit stays spent.
       */
      refundable: boolean;
    };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** gRPC codes of a per-image error (`google.rpc.Status`) that need a word of their own. */
const GRPC_INVALID_ARGUMENT = 3;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_RESOURCE_EXHAUSTED = 8;
const GRPC_UNAUTHENTICATED = 16;

/**
 * The failure of one image inside a 200 answer. Key, billing and API problems are named by
 * Google's reasons; "bad image data" blames the photo; anything else is a failed attempt.
 */
function perImageFailure(error: unknown): VisionFailure {
  const info = errorInfoOf(error);
  const code = isRecord(error) && typeof error.code === 'number' ? error.code : 0;
  if (code === GRPC_RESOURCE_EXHAUSTED && info.status === '') info.status = 'RESOURCE_EXHAUSTED';
  const known = classifyKnown(0, info);
  if (known) return known;
  if (code === GRPC_PERMISSION_DENIED || code === GRPC_UNAUTHENTICATED) return 'invalid';
  if (code === GRPC_INVALID_ARGUMENT || /bad image data/i.test(info.message)) return 'photo';
  return 'network';
}

/** HTTP statuses on which a refusal that Google names is known not to have been billed. */
const UNBILLED_REFUSALS: ReadonlySet<number> = new Set([400, 403, 429]);

/**
 * An HTTP refusal. A recognised one is the key's or the project's problem, and free of charge on
 * the statuses of `UNBILLED_REFUSALS`. An unrecognised 400 or 413 blames the image, any other
 * unrecognised refusal reads as a bad key; neither is known to be free of charge.
 */
async function refusal(response: Response): Promise<WebDetectResult> {
  const known = classifyKnown(response.status, await readError(response));
  if (known) {
    return { ok: false, reason: known, refundable: UNBILLED_REFUSALS.has(response.status) };
  }
  const imageProblem = response.status === 400 || response.status === 413;
  return { ok: false, reason: imageProblem ? 'photo' : 'invalid', refundable: false };
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
  // Never sent, so never billed.
  if (!isHeaderSafe(key)) return { ok: false, reason: 'invalid', refundable: true };

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
    // Google having a bad moment says nothing about the key, and may have billed the call.
    if (response.status >= 500) return { ok: false, reason: 'network', refundable: false };
    if (!response.ok) return await refusal(response);

    const body: unknown = await response.json();
    const first = isRecord(body) && Array.isArray(body.responses) ? body.responses[0] : undefined;
    if (!isRecord(first)) return { ok: false, reason: 'network', refundable: false };
    // The call went through but this image failed: no result, yet not proven free of charge.
    if (first.error !== undefined && first.error !== null) {
      return { ok: false, reason: perImageFailure(first.error), refundable: false };
    }
    // A photo with no match at all comes back without `webDetection`.
    return { ok: true, webDetection: sanitizeWebDetection(first.webDetection) };
  } catch {
    // A timeout, an abort or a failed request: Google may have received the image.
    return { ok: false, reason: 'network', refundable: false };
  } finally {
    clearTimeout(timer);
  }
}
