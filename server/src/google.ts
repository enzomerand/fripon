import type { FetchLike } from '../../lib/fetch';
import {
  GEMINI_MODEL,
  reviewListing,
  type GeminiFailure,
  type ReviewInput,
  type ReviewResult,
} from '../../lib/google/gemini';
import { isKeyFailure } from '../../lib/google/refusal';
import { webDetect, type WebDetectResult } from '../../lib/google/vision';
import { CLAUDE_REVIEW_MODEL, reviewWithClaude } from './claude';
import type { AiProvider, Config } from './config';

/**
 * The AI review step, with the provider chosen at startup (`AI_PROVIDER`) and its key already
 * bound: the routes never know which one runs, they only name it in the logs and the alerts and
 * hash its model into the shared cache key. Both providers answer the same `ReviewResult`.
 */
export interface Reviewer {
  provider: AiProvider;
  /** The model id: another model is another review, so it is part of the shared cache key. */
  model: string;
  /** The paid call (Gemini or Claude, same input, same failure words, same refund rule). */
  review(input: ReviewInput): Promise<ReviewResult>;
}

/**
 * Everything the proxy routes ask of the outside world. The real ones are the extension's own
 * modules (`lib/google/*`) and the Claude one (`claude.ts`), so the prompt, the validation and the
 * refund rule never drift; tests pass fakes. The Vision key is read from the config, right at the
 * call; the review key never appears in the routes (the reviewer holds it).
 */
export interface GoogleDeps {
  /** Downloads a photo (guards are applied by the caller: `downloadPhoto`). */
  fetch: FetchLike;
  /** The paid Vision call (WEB_DETECTION). */
  webDetect(base64: string, key: string): Promise<WebDetectResult>;
  /** The paid AI review, for the provider and the key the server started with. */
  reviewer: Reviewer;
}

/** The reviewer of `config.aiProvider`, bound to its key. `fetchImpl` is for tests. */
export function realReviewer(
  config: Pick<Config, 'aiProvider' | 'geminiKey' | 'anthropicKey'>,
  fetchImpl: typeof fetch = fetch,
): Reviewer {
  if (config.aiProvider === 'claude') {
    return {
      provider: 'claude',
      model: CLAUDE_REVIEW_MODEL,
      review: (input) => reviewWithClaude(input, config.anthropicKey, { fetch: fetchImpl }),
    };
  }
  return {
    provider: 'gemini',
    model: GEMINI_MODEL,
    review: (input) => reviewListing(input, config.geminiKey, (url, init) => fetchImpl(url, init)),
  };
}

export function realGoogleDeps(
  config: Pick<Config, 'aiProvider' | 'geminiKey' | 'anthropicKey'>,
): GoogleDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    webDetect: (base64, key) => webDetect(base64, key),
    reviewer: realReviewer(config),
  };
}

/** What a client is told when a paid step fails: never more than this. */
export type UpstreamReason = 'network' | 'unavailable' | 'photo' | 'invalid_answer';

/**
 * A paid step's failure as the client may read it. The owner's key, billing and quota are the owner's
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
 * Whether a failure is the owner's to fix: a refused key, a project without billing (or an
 * Anthropic account without credit), a quota, or a service that is gone (a retired model). A
 * timeout or an unreadable answer is the provider having a bad moment, and the photo is the
 * photo's problem.
 */
export function isOwnerProblem(reason: GeminiFailure): boolean {
  return isKeyFailure(reason) || reason === 'quota' || reason === 'unavailable';
}
