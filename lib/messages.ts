import { browser } from 'wxt/browser';
import type { ImageGate } from './gate';
import type { KeyCheckResult } from './google/key-check';
import type { VisionFailure } from './google/vision';
import type { ImageMatch } from './model';
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
 * answer stay in the background: the page only gets the matches.
 */
export interface SearchImageRequest {
  type: 'searchImage';
  photoUrl: string;
}

/** Why a search failed (see `VisionFailure`); `photo` blames the image, not the key or Google. */
export type SearchImageFailure = VisionFailure;

export type SearchImageResponse =
  | { status: 'ok'; matches: ImageMatch[] }
  /** No Vision key saved: nothing was sent. */
  | { status: 'no_key' }
  /** The Vision cap is reached for this period: nothing was sent. */
  | { status: 'quota' }
  /** The search did not complete; no credit was kept for it. */
  | { status: 'error'; reason: SearchImageFailure };

/**
 * Ask whether the reverse image search may run. The keys stay in the background: a content script
 * only ever learns this one word.
 */
export interface GetImageGateRequest {
  type: 'getImageGate';
}

/** Parts of the options page a message can point at (the page scrolls to the matching id). */
export const OPTIONS_SECTIONS = ['guide', 'keys', 'credits'] as const;
export type OptionsSection = (typeof OPTIONS_SECTIONS)[number];

/** Open the options page (or bring the open one to the front), at `section` when given. */
export interface OpenOptionsRequest {
  type: 'openOptions';
  section?: OptionsSection;
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
  | GetImageGateRequest
  | OpenOptionsRequest
  | TestKeyRequest;

/** Response type of each message, keyed by `type`. */
export interface RuntimeResponses {
  analyzeImage: AnalyzeImageResponse;
  searchImage: SearchImageResponse;
  getImageGate: ImageGate;
  openOptions: void;
  testKey: KeyCheckResult;
}

export type ResponseFor<M extends RuntimeMessage> = RuntimeResponses[M['type']];

/** Narrowing guard for the background's `onMessage` listener. */
export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as {
    type?: unknown;
    url?: unknown;
    photoUrl?: unknown;
    section?: unknown;
    provider?: unknown;
    key?: unknown;
  };
  switch (message.type) {
    case 'analyzeImage':
      return typeof message.url === 'string';
    case 'searchImage':
      return typeof message.photoUrl === 'string';
    case 'getImageGate':
      return true;
    case 'openOptions':
      return (
        message.section === undefined ||
        OPTIONS_SECTIONS.includes(message.section as OptionsSection)
      );
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
