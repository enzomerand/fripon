import { classifyKnown, readError, type KeyCheckFailure } from './key-check';

/**
 * Why a paid Google call failed: the words of a key check (see `KeyCheckFailure`), `photo` when
 * the problem is the image itself (Google could not read it, or it is too big), or `unavailable`
 * when the service itself is out of reach for reasons that are neither the key's nor the photo's
 * (a model that is gone, a request Google will not take, a region it does not serve).
 */
export type CallFailure = KeyCheckFailure | 'photo' | 'unavailable';

/** Failures that come from the key or its project, and that the user fixes in Google Cloud. */
export function isKeyFailure(reason: string): boolean {
  return (
    reason === 'invalid' || reason === 'restricted' || reason === 'disabled' || reason === 'billing'
  );
}

/** What a refused call blames, and whether its credit can go back (see `readRefusal`). */
export interface Refusal {
  reason: CallFailure;
  /**
   * true only when Google certainly did not bill the call: it answered 400, 402, 403 or 429 with a
   * refusal its error body names (invalid key, API blocked or disabled, billing off, quota), or
   * 404 with `NOT_FOUND` (nothing ran).
   */
  refundable: boolean;
  /**
   * true when the refusal may be about this very request (an unrecognised 400 of Gemini: the
   * photo, its format) and says nothing sure about the service: it is not remembered for the
   * next listings.
   */
  specific?: true;
}

/**
 * HTTP statuses on which a refusal that Google names is known not to have been billed (402: no
 * credit left to bill it with).
 */
const UNBILLED_REFUSALS: ReadonlySet<number> = new Set([400, 402, 403, 429]);

/**
 * Reads an HTTP refusal of a paid Google call (Vision, Gemini). One that Google's error body names
 * is the key's or the project's problem, and free of charge on the statuses of `UNBILLED_REFUSALS`.
 * A bare 429 (nothing readable in the body) still reads as a quota, but proves nothing about
 * billing, so it keeps the credit.
 *
 * A 404, or a body that says `NOT_FOUND`, is a service that is gone (a retired model): it is
 * `unavailable`, not a bad key, and free of charge only when Google says `NOT_FOUND`. A 413 blames
 * the image. What an unrecognised 400 means depends on the call: for Vision it is a problem with
 * the image or its payload (`photo`, the default), for Gemini it is the request or the region
 * (`unavailable`, said by `unnamed400`), but it may as well be this very photo (a format Gemini
 * refuses), so it is marked `specific` and not remembered. Any other unrecognised refusal reads as
 * a bad key. None of these is known to be free of charge.
 *
 * This is the one place where the refund rule lives: a call that was never refused (a timeout, a
 * 5xx, an unreadable answer) may have been processed, and the caller keeps its credit.
 */
export async function readRefusal(
  response: Response,
  unnamed400: 'photo' | 'unavailable' = 'photo',
): Promise<Refusal> {
  const info = await readError(response);
  // Status 0: only what the body says counts, not the HTTP status.
  const named = classifyKnown(0, info);
  const known = named ?? (response.status === 429 ? 'quota' : null);
  if (known) {
    return { reason: known, refundable: named !== null && UNBILLED_REFUSALS.has(response.status) };
  }
  if (response.status === 404 || info.status === 'NOT_FOUND') {
    return { reason: 'unavailable', refundable: info.status === 'NOT_FOUND' };
  }
  if (response.status === 400) {
    return unnamed400 === 'photo'
      ? { reason: 'photo', refundable: false }
      : { reason: unnamed400, refundable: false, specific: true };
  }
  if (response.status === 413) return { reason: 'photo', refundable: false };
  return { reason: 'invalid', refundable: false };
}
