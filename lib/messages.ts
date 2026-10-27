import { browser } from 'wxt/browser';
import { isAiReviewInput, type AiReviewInput } from './ai/input';
import type { BadgeVerdict } from './background/badge';
import type { Gates } from './gate';
import type { GeminiFailure } from './google/gemini';
import type { KeyCheckResult } from './google/key-check';
import type { VisionFailure } from './google/vision';
import type { AiReview, ImageMatch, VerdictLevel } from './model';
import type { Provider } from './settings';

/** Ask the background to fetch a photo and compute its pixel heuristics. */
export interface AnalyzeImageRequest {
  type: 'analyzeImage';
  url: string;
}

export type AnalyzeImageResponse =
  | {
      ok: true;
      /** 64-bit difference hash as 16 lowercase hex digits (see `hexToHash`). */
      hash: string;
      /** 0..1 studio / catalogue estimate (see `catalogScore`). */
      catalogScore: number;
    }
  | { ok: false; error: string };

/**
 * Ask the background to run the reverse image search (Google Vision) on a listing photo. Costs one
 * Vision credit unless the same photo was searched in the last 7 days. The key and the raw
 * answer stay in the background: the page only gets the matches. With `cacheOnly` (the "Au clic"
 * mode) nothing is ever spent: the answer is the cached result, or `not_cached`. With `retry` (the
 * user clicked a button) a quota or a network failure that the background remembers for a moment
 * is tried again instead of being answered again.
 */
export interface SearchImageRequest {
  type: 'searchImage';
  photoUrl: string;
  cacheOnly?: boolean;
  retry?: boolean;
}

export type SearchImageResponse =
  | { status: 'ok'; matches: ImageMatch[] }
  /** No Vision key saved: nothing was sent. */
  | { status: 'no_key' }
  /** The Vision cap is reached for this period: nothing was sent. */
  | { status: 'quota' }
  /** Only for `cacheOnly`: this photo was not searched in the last 7 days. */
  | { status: 'not_cached' }
  /** The search did not complete; no credit was kept for it. */
  | { status: 'error'; reason: VisionFailure };

/**
 * Ask the background to have Gemini review a listing: a summary of the signals Fripon computed, and
 * whether the photo looks like a catalogue shot. Costs one Gemini credit unless the same review
 * was made in the last 7 days. The key and the raw answer stay in the background: the page only
 * gets the review. With `cacheOnly` (the "Au clic" mode) nothing is ever spent: the answer is the
 * cached review, or `not_cached`. `retry` is the same as for `searchImage`.
 */
export interface AiReviewRequest {
  type: 'aiReview';
  input: AiReviewInput;
  cacheOnly?: boolean;
  retry?: boolean;
}

export type AiReviewResponse =
  | { status: 'ok'; review: AiReview }
  /** No Gemini key saved: nothing was sent. */
  | { status: 'no_key' }
  /** The Gemini cap is reached for this period: nothing was sent. */
  | { status: 'quota' }
  /** Only for `cacheOnly`: this listing was not reviewed in the last 7 days. */
  | { status: 'not_cached' }
  /** The review did not complete; the credit was only given back when Google certainly did not bill it. */
  | { status: 'error'; reason: GeminiFailure };

/**
 * Ask whether the paid steps may run. The keys stay in the background: a content script only ever
 * learns these two words.
 */
export interface GetGatesRequest {
  type: 'getGates';
}

/**
 * Ask how many Vision credits are left in the current period. Only a count: the key and the
 * counters stay in the background. For display (the confirmation before a batch); the background
 * still `reserve`s a credit before each paid call.
 */
export interface GetVisionUsageRequest {
  type: 'getVisionUsage';
}

export interface VisionUsage {
  /** Credits left before the cap, null when there is no cap (or it could not be read). */
  remaining: number | null;
}

/** Parts of the options page a message can point at (the page scrolls to the matching id). */
export const OPTIONS_SECTIONS = ['guide', 'keys', 'credits'] as const;
export type OptionsSection = (typeof OPTIONS_SECTIONS)[number];

/** Open the options page (or bring the open one to the front), at `section` when given. */
export interface OpenOptionsRequest {
  type: 'openOptions';
  section?: OptionsSection;
}

/** Longest verdict title the background puts in the tooltip of the toolbar button. */
export const BADGE_TITLE_MAX = 120;

/**
 * Show the verdict of the open listing on the toolbar button of the sender's tab, or clear it with
 * `null`. Only the level and the title travel. Only accepted from a content script on a Vinted
 * page (it needs a tab), never from an extension page.
 */
export interface SetVerdictBadgeRequest {
  type: 'setVerdictBadge';
  verdict: BadgeVerdict | null;
}

/**
 * Check the key `key` for `provider`, for free: a candidate the user typed, not saved yet. Only
 * accepted from the extension's own pages, never from a content script: a key must not travel
 * through a web page's context.
 */
export interface TestKeyRequest {
  type: 'testKey';
  provider: Provider;
  key: string;
}

/** Every message the background understands. Add new requests here. */
export type RuntimeMessage =
  | AnalyzeImageRequest
  | SearchImageRequest
  | AiReviewRequest
  | GetGatesRequest
  | GetVisionUsageRequest
  | OpenOptionsRequest
  | SetVerdictBadgeRequest
  | TestKeyRequest;

/** Response type of each message, keyed by `type`. */
export interface RuntimeResponses {
  analyzeImage: AnalyzeImageResponse;
  searchImage: SearchImageResponse;
  aiReview: AiReviewResponse;
  getGates: Gates;
  getVisionUsage: VisionUsage;
  openOptions: void;
  setVerdictBadge: void;
  testKey: KeyCheckResult;
}

export type ResponseFor<M extends RuntimeMessage> = RuntimeResponses[M['type']];

const VERDICT_LEVELS = Object.keys({
  dropshipping: true,
  resold: true,
  review: true,
  clean: true,
} satisfies Record<VerdictLevel, true>);

/** A verdict as the badge takes it: a known level and a short, non-empty title. */
function isBadgeVerdict(value: unknown): value is BadgeVerdict {
  if (typeof value !== 'object' || value === null) return false;
  const { level, title } = value as { level?: unknown; title?: unknown };
  return (
    typeof level === 'string' &&
    VERDICT_LEVELS.includes(level) &&
    typeof title === 'string' &&
    title.length > 0 &&
    title.length <= BADGE_TITLE_MAX
  );
}

/** Narrowing guard for the background's `onMessage` listener. */
export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as {
    type?: unknown;
    url?: unknown;
    photoUrl?: unknown;
    cacheOnly?: unknown;
    retry?: unknown;
    input?: unknown;
    section?: unknown;
    verdict?: unknown;
    provider?: unknown;
    key?: unknown;
  };
  switch (message.type) {
    case 'analyzeImage':
      return typeof message.url === 'string';
    case 'searchImage':
      return (
        typeof message.photoUrl === 'string' &&
        (message.cacheOnly === undefined || typeof message.cacheOnly === 'boolean') &&
        (message.retry === undefined || typeof message.retry === 'boolean')
      );
    case 'aiReview':
      return (
        isAiReviewInput(message.input) &&
        (message.cacheOnly === undefined || typeof message.cacheOnly === 'boolean') &&
        (message.retry === undefined || typeof message.retry === 'boolean')
      );
    case 'getGates':
    case 'getVisionUsage':
      return true;
    case 'openOptions':
      return (
        message.section === undefined ||
        OPTIONS_SECTIONS.includes(message.section as OptionsSection)
      );
    case 'setVerdictBadge':
      return message.verdict === null || isBadgeVerdict(message.verdict);
    case 'testKey':
      return (
        (message.provider === 'vision' || message.provider === 'gemini') &&
        typeof message.key === 'string'
      );
    default:
      return false;
  }
}

/** Typed wrapper around `browser.runtime.sendMessage`: the response type follows the request. */
export async function sendMessage<M extends RuntimeMessage>(message: M): Promise<ResponseFor<M>> {
  return (await browser.runtime.sendMessage(message)) as ResponseFor<M>;
}
