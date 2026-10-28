import type { FetchLike } from '../../lib/fetch';
import {
  GEMINI_URL,
  reviewListing,
  type GeminiFailure,
  type ReviewInput,
  type ReviewResult,
} from '../../lib/google/gemini';
import { isKeyFailure } from '../../lib/google/refusal';
import { webDetect, type WebDetectResult } from '../../lib/google/vision';

/**
 * Everything the proxy routes ask of the outside world. The real ones are the extension's own
 * modules (`lib/google/*`), so the prompt, the validation and the refund rule never drift; tests
 * pass fakes, and the keys never appear here: they are read from the config, right at the call.
 */
export interface GoogleDeps {
  /** Downloads a photo (guards are applied by the caller: `downloadPhoto`). */
  fetch: FetchLike;
  /** The paid Vision call (WEB_DETECTION). */
  webDetect(base64: string, key: string): Promise<WebDetectResult>;
  /** The paid Gemini call. */
  reviewListing(input: ReviewInput, key: string): Promise<ReviewResult>;
}

/** `geminiUrl`: the Gemini API by default, or Vertex AI (`vertexGeminiUrl`, see `config.ts`). */
export function realGoogleDeps(geminiUrl: string = GEMINI_URL): GoogleDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    webDetect: (base64, key) => webDetect(base64, key),
    reviewListing: (input, key) =>
      reviewListing(input, key, (url, init) => fetch(url, init), geminiUrl),
  };
}

/** What a client is told when a Google step fails: never more than this. */
export type UpstreamReason = 'network' | 'unavailable' | 'photo' | 'invalid_answer';

/**
 * A Google failure as the client may read it. The owner's key, billing and quota are the owner's
 * problem, not the client's: they all read as `unavailable` (and are logged, see `ownerProblem`).
 */
export function upstreamReason(reason: GeminiFailure): UpstreamReason {
  switch (reason) {
    case 'photo':
    case 'network':
    case 'unavailable':
    case 'invalid_answer':
      return reason;
    default:
      return 'unavailable';
  }
}

/**
 * Whether a failure is the owner's to fix: a refused key, a project without billing, a quota, or a
 * service that is gone (a retired Gemini model). A timeout or an unreadable answer is Google
 * having a bad moment, and the photo is the photo's problem.
 */
export function isOwnerProblem(reason: GeminiFailure): boolean {
  return isKeyFailure(reason) || reason === 'quota' || reason === 'unavailable';
}
