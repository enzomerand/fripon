import { classifyKnown, readError, type KeyCheckFailure } from './key-check';

/**
 * Why a paid Google call failed: the words of a key check (see `KeyCheckFailure`), or `photo` when
 * the problem is the image itself (Google could not read it, or it is too big).
 */
export type CallFailure = KeyCheckFailure | 'photo';

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
   * true only when Google certainly did not bill the call: it answered 400, 403 or 429 with a
   * refusal its error body names (invalid key, API blocked or disabled, billing off, quota).
   */
  refundable: boolean;
}

/** HTTP statuses on which a refusal that Google names is known not to have been billed. */
const UNBILLED_REFUSALS: ReadonlySet<number> = new Set([400, 403, 429]);

/**
 * Reads an HTTP refusal of a paid Google call (Vision, Gemini). One that Google's error body names
 * is the key's or the project's problem, and free of charge on the statuses of `UNBILLED_REFUSALS`.
 * A bare 429 (nothing readable in the body) still reads as a quota, but proves nothing about
 * billing, so it keeps the credit. An unrecognised 400 or 413 blames the image, any other
 * unrecognised refusal reads as a bad key; neither is known to be free of charge.
 *
 * This is the one place where the refund rule lives: a call that was never refused (a timeout, a
 * 5xx, an unreadable answer) may have been processed, and the caller keeps its credit.
 */
export async function readRefusal(response: Response): Promise<Refusal> {
  // Status 0: only what the body says counts, not the HTTP status.
  const named = classifyKnown(0, await readError(response));
  const known = named ?? (response.status === 429 ? 'quota' : null);
  if (known) {
    return { reason: known, refundable: named !== null && UNBILLED_REFUSALS.has(response.status) };
  }
  const imageProblem = response.status === 400 || response.status === 413;
  return { reason: imageProblem ? 'photo' : 'invalid', refundable: false };
}
