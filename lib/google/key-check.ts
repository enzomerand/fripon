import type { FetchLike } from '../fetch';
import { isRecord } from '../json';
import type { Provider } from '../provider';

/** A key check that takes longer than this counts as a network failure. */
export const KEY_CHECK_TIMEOUT_MS = 10_000;

/**
 * - invalid: Google does not accept this key (typo, deleted, expired, restricted to other APIs...).
 * - disabled: the key is fine but the API is not enabled on its project.
 * - restricted: the key is limited to other APIs, so it cannot call this one.
 * - billing: the API needs billing, which is not enabled on the project.
 * - quota: the key is fine but its quota is used up right now.
 * - network: Google could not be reached in time, or answered with a server error.
 */
export type KeyCheckFailure =
  'invalid' | 'disabled' | 'restricted' | 'billing' | 'quota' | 'network';

export type KeyCheckResult = { ok: true } | { ok: false; reason: KeyCheckFailure };

interface GoogleErrorInfo {
  status: string;
  message: string;
  /** Normalised `google.rpc.ErrorInfo` reasons, plus the legacy `errors[].reason` ones. */
  reasons: string[];
}

/**
 * The probe of each provider. Both cost nothing: a model listing, and an annotate with no image.
 * Verified against Google with a real key: Vision answers `{"requests":[]}` with 200 `{}` and
 * counts no unit, a bogus key gets 400 API_KEY_INVALID, a project without the API gets 403
 * SERVICE_DISABLED.
 */
const PROBES: Record<Provider, { url: string; init: RequestInit }> = {
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    init: { method: 'GET' },
  },
  vision: {
    url: 'https://vision.googleapis.com/v1/images:annotate',
    init: { method: 'POST', body: JSON.stringify({ requests: [] }) },
  },
};

const HEADER_SAFE = /^[\x21-\x7e]+$/;

/** A header value must be printable ASCII: anything else would make `fetch` throw. */
export function isHeaderSafe(key: string): boolean {
  return HEADER_SAFE.test(key);
}

/** What a Google `error` object (an HTTP error body, or a per-image error) says about itself. */
export function errorInfoOf(error: unknown): GoogleErrorInfo {
  const info: GoogleErrorInfo = { status: '', message: '', reasons: [] };
  if (!isRecord(error)) return info;
  if (typeof error.status === 'string') info.status = error.status;
  if (typeof error.message === 'string') info.message = error.message;
  for (const list of [error.details, error.errors]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (isRecord(entry) && typeof entry.reason === 'string') {
        info.reasons.push(normaliseReason(entry.reason));
      }
    }
  }
  return info;
}

/** Reads the error of a failed response; an unreadable body gives an empty info. */
export async function readError(response: Response): Promise<GoogleErrorInfo> {
  // Reading the text may time out: that error is left to the caller (a network failure).
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorInfoOf(null);
  }
  return errorInfoOf(isRecord(body) ? body.error : null);
}

/** "SERVICE_DISABLED" and the legacy "accessNotConfigured" compare as plain upper-case words. */
const normaliseReason = (reason: string) => reason.replaceAll('_', '').toUpperCase();

const has = (info: GoogleErrorInfo, ...reasons: string[]) =>
  reasons.some((reason) => info.reasons.includes(normaliseReason(reason)));

/**
 * The failure Google's answer names outright, null when it names none. Per-image errors use this
 * one: an unrecognised refusal there says nothing about the key.
 */
export function classifyKnown(status: number, info: GoogleErrorInfo): KeyCheckFailure | null {
  // The key is restricted to other APIs (403 PERMISSION_DENIED): not a disabled API, a restriction.
  if (has(info, 'API_KEY_SERVICE_BLOCKED')) return 'restricted';
  if (has(info, 'API_KEY_INVALID')) return 'invalid';
  // 402 Payment Required: a prepaid Gemini plan without credits (« Your prepayment credits are
  // depleted »), sent with RESOURCE_EXHAUSTED, which is not a quota the user can wait out.
  if (
    status === 402 ||
    has(info, 'BILLING_DISABLED') ||
    /requires billing|billing (is )?(not enabled|disabled)|prepayment credits/i.test(info.message)
  ) {
    return 'billing';
  }
  if (
    has(info, 'SERVICE_DISABLED', 'ACCESS_NOT_CONFIGURED') ||
    /has not been used in project|is disabled|not been enabled/i.test(info.message)
  ) {
    return 'disabled';
  }
  if (status === 429 || info.status === 'RESOURCE_EXHAUSTED') return 'quota';
  return null;
}

/** An HTTP refusal: API_KEY_INVALID (400 INVALID_ARGUMENT) and every other one are `invalid`. */
function classify(status: number, info: GoogleErrorInfo): KeyCheckFailure {
  return classifyKnown(status, info) ?? 'invalid';
}

/**
 * Asks Google whether `key` works for `provider`, without spending a credit. The key travels in
 * the `x-goog-api-key` header, never in the URL (URLs end up in logs and history).
 */
export async function checkKey(
  provider: Provider,
  key: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<KeyCheckResult> {
  if (!isHeaderSafe(key)) return { ok: false, reason: 'invalid' };

  const probe = PROBES[provider];
  const controller = new AbortController();
  // Covers the whole exchange, body included.
  const timer = setTimeout(() => controller.abort(), KEY_CHECK_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'x-goog-api-key': key };
    if (probe.init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetchImpl(probe.url, {
      ...probe.init,
      headers,
      credentials: 'omit',
      signal: controller.signal,
    });
    if (response.ok) return { ok: true };
    // Google having a bad moment says nothing about the key.
    if (response.status >= 500) return { ok: false, reason: 'network' };
    return { ok: false, reason: classify(response.status, await readError(response)) };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
