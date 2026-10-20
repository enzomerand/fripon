import { browser } from 'wxt/browser';

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

/** Every message the background understands. Add new requests here. */
export type RuntimeMessage = AnalyzeImageRequest;

/** Response type of each message, keyed by `type`. */
export interface RuntimeResponses {
  analyzeImage: AnalyzeImageResponse;
}

export type ResponseFor<M extends RuntimeMessage> = RuntimeResponses[M['type']];

/** Narrowing guard for the background's `onMessage` listener. */
export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { type?: unknown; url?: unknown };
  return message.type === 'analyzeImage' && typeof message.url === 'string';
}

/** Typed wrapper around `browser.runtime.sendMessage`: the response type follows the request. */
export async function sendMessage<M extends RuntimeMessage>(message: M): Promise<ResponseFor<M>> {
  return (await browser.runtime.sendMessage(message)) as ResponseFor<M>;
}
