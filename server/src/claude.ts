import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  type ClientOptions,
} from '@anthropic-ai/sdk';
import {
  buildPrompt,
  parseReview,
  type ReviewInput,
  type ReviewResult,
} from '../../lib/google/gemini';
import { isHeaderSafe } from '../../lib/google/key-check';

/**
 * The AI review of Fripon Cloud, written by Claude Haiku 5.5 through the Anthropic API instead of
 * Gemini (`AI_PROVIDER=claude`, see `config.ts`): the Anthropic API is prepaid with optional
 * auto-reload, and cheaper per token. The extension's own (personal key) mode keeps Gemini.
 *
 * Same contract as `reviewListing` of `lib/google/gemini.ts`: same input, same prompt (the quoting
 * rules against forged seller text), same strict validation of the answer (`parseReview`), same
 * failure words and same refund rule. This module runs on the server only: it needs the official SDK.
 */

/** The model behind the AI review in subscriber mode: no date suffix, the alias is the model. */
export const CLAUDE_REVIEW_MODEL = 'claude-haiku-5-5';
/** A call that takes longer than this (answer body included) counts as a network failure. */
export const CLAUDE_TIMEOUT_MS = 30_000;
/**
 * The ceiling of the answer, thinking included (adaptive thinking is on by default on this model,
 * and its tokens count here): a summary is 200 tokens at most, the rest is room for the thinking.
 * Billed on use, not on the ceiling.
 */
const MAX_OUTPUT_TOKENS = 4_000;
/** The API refuses an image over 5 MB (counted on the base64 text). */
export const CLAUDE_IMAGE_MAX_BASE64_CHARS = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

/** What Claude must answer: structured outputs guarantee a JSON text that follows this schema. */
const REVIEW_SCHEMA = {
  type: 'object',
  properties: { catalogPhoto: { type: 'boolean' }, summary: { type: 'string' } },
  required: ['catalogPhoto', 'summary'],
  additionalProperties: false,
};

/** Only a test hands a fake `fetch`: the SDK is the real one. */
export interface ClaudeDeps {
  fetch?: ClientOptions['fetch'];
}

type Failed = Extract<ReviewResult, { ok: false }>;

const imageTypeOf = (mimeType: string): ImageType | undefined =>
  IMAGE_TYPES.find((type) => type === mimeType);

/**
 * The credit balance of the Anthropic account is empty. It is a 400 `invalid_request_error`, whose
 * message is the only thing that tells it from a bad request: the one place where a message is read.
 */
const isLowCredit = (error: BadRequestError) => /credit balance is too low/i.test(error.message);

/**
 * Anthropic's error type of a refused request, for the log. Only the type: its message may echo
 * what was sent, and nothing the API said is ever logged.
 */
function refusalOf(error: BadRequestError): string {
  const body = error.error as { error?: { type?: unknown } } | undefined;
  const type = body?.error?.type;
  return typeof type === 'string' && /^[a-z_]{1,64}$/.test(type) ? type : 'error';
}

/**
 * A call the API refused or could not finish, as a failure of the repo's vocabulary. The refund
 * rule is the repo's own: refundable only when Anthropic certainly did not bill the call (it
 * refused the request itself), never for a timeout or a 5xx, which may have been processed.
 * Never carries the error's text: the caller only ever reads the words.
 */
function failureOf(error: unknown): Failed {
  // The most specific classes first (the connection errors are `APIError`s too).
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return { ok: false, reason: 'invalid', refundable: true };
  }
  if (error instanceof RateLimitError) {
    return { ok: false, reason: 'quota', refundable: true };
  }
  if (error instanceof BadRequestError) {
    if (isLowCredit(error)) return { ok: false, reason: 'billing', refundable: true };
    // The request, or this very photo: refused before any work, but not remembered for the next
    // listings (see `Refusal.specific`). Neither alerted nor remembered, so it is logged: a request
    // refused every time would otherwise leave no trace.
    console.warn(`[claude] request refused (400 ${refusalOf(error)})`);
    return { ok: false, reason: 'unavailable', specific: true, refundable: true };
  }
  if (error instanceof NotFoundError) {
    return { ok: false, reason: 'unavailable', refundable: true };
  }
  if (error instanceof APIConnectionError) {
    return { ok: false, reason: 'network', refundable: false };
  }
  if (error instanceof APIError) {
    // 402 `billing_error`; 413 a request over the size limit, both refused before any work.
    if (error.status === 402) return { ok: false, reason: 'billing', refundable: true };
    if (error.status === 413) return { ok: false, reason: 'photo', refundable: true };
    // 529 `overloaded_error` and any 5xx: Anthropic having a bad moment says nothing about the
    // key, and the call may have been billed. An abort (no status) reads the same.
    if (error.status === undefined || error.status >= 500) {
      return { ok: false, reason: 'network', refundable: false };
    }
    // Any other 4xx (409, 422...): nothing known about billing, nothing known about the key.
    return { ok: false, reason: 'unavailable', refundable: false };
  }
  // Not the SDK's: a body that cannot be read, a bug. Anthropic may have received the request.
  return { ok: false, reason: 'network', refundable: false };
}

/** The JSON that the text blocks of an answer hold, undefined when there is none. */
function answerOf(message: Anthropic.Message): unknown {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Asks Claude to review a listing. This is the paid call: the caller must have reserved its
 * credit first. The request is built for Claude Haiku 5.5: adaptive thinking (the default, not
 * sent) at the lowest effort, the answer in structured outputs (`output_config.format`), no
 * sampling parameter (`temperature`, `top_p`, `top_k` are refused with a 400), no prefill.
 *
 * Never retries (`maxRetries: 0`): the client waits 45 s at most, and a retry is a second billed
 * call. Never throws, never logs, never returns the key.
 */
export async function reviewWithClaude(
  input: ReviewInput,
  apiKey: string,
  deps: ClaudeDeps = {},
): Promise<ReviewResult> {
  // Never sent, so never billed.
  if (!isHeaderSafe(apiKey)) return { ok: false, reason: 'invalid', refundable: true };
  const mediaType = imageTypeOf(input.photo.mimeType);
  if (!mediaType || input.photo.base64.length > CLAUDE_IMAGE_MAX_BASE64_CHARS) {
    return { ok: false, reason: 'photo', refundable: true };
  }

  try {
    const client = new Anthropic({
      apiKey,
      maxRetries: 0,
      timeout: CLAUDE_TIMEOUT_MS,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    const message = await client.messages.create(
      {
        model: CLAUDE_REVIEW_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: REVIEW_SCHEMA },
        },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: input.photo.base64 },
              },
              { type: 'text', text: buildPrompt(input) },
            ],
          },
        ],
      },
      // The SDK's own timeout stops at the answer's headers: this one covers the body too.
      { signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS) },
    );

    // The model declined, or ran out of room (thinking included): processed, and billed.
    if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') {
      return { ok: false, reason: 'invalid_answer', refundable: false };
    }
    const review = parseReview(answerOf(message));
    if (!review) return { ok: false, reason: 'invalid_answer', refundable: false };
    return { ok: true, review };
  } catch (error) {
    return failureOf(error);
  }
}
