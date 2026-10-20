import { browser } from 'wxt/browser';
import type { ImageGate } from './gate';
import type { KeyCheckResult } from './google/key-check';
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
 * Check a key for `provider`, for free: `key` when given (a candidate the user typed, not saved
 * yet), else the one saved. Only accepted from the extension's own pages, never from a content
 * script: a key must not travel through a web page's context. The answer is empty when the
 * background could not read the saved key.
 */
export interface TestKeyRequest {
  type: 'testKey';
  provider: Provider;
  key?: string;
}

/** Every message the background understands. Add new requests here. */
export type RuntimeMessage =
  AnalyzeImageRequest | GetImageGateRequest | OpenOptionsRequest | TestKeyRequest;

/** Response type of each message, keyed by `type`. */
export interface RuntimeResponses {
  analyzeImage: AnalyzeImageResponse;
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
    section?: unknown;
    provider?: unknown;
    key?: unknown;
  };
  switch (message.type) {
    case 'analyzeImage':
      return typeof message.url === 'string';
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
        (message.key === undefined || typeof message.key === 'string')
      );
    default:
      return false;
  }
}

/** Typed wrapper around `browser.runtime.sendMessage`: the response type follows the request. */
export async function sendMessage<M extends RuntimeMessage>(message: M): Promise<ResponseFor<M>> {
  return (await browser.runtime.sendMessage(message)) as ResponseFor<M>;
}
