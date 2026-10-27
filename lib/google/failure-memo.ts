import { isKeyFailure } from './refusal';

/** A key Google refused is remembered this long: further listings do not retry it. */
export const KEY_FAILURE_MEMO_MS = 10 * 60 * 1000;
/**
 * A quota, a network failure or an unavailable service is remembered this long: in automatic mode
 * every listing opened in the meantime would otherwise download its photo and call Google again,
 * for the same answer (and a credit each time when Google may have billed it).
 */
export const TRANSIENT_FAILURE_MEMO_MS = 90 * 1000;

/** The failures that pass by themselves, and so are only remembered for a short while. */
const TRANSIENT: readonly string[] = ['quota', 'network', 'unavailable'];

/** What `createFailureMemo` returns. */
export interface FailureMemo<R extends string> {
  /**
   * The failure to answer with instead of calling Google, null when the call should go ahead. It
   * is remembered for this very key only: saving another one tries again at once. With `retry`
   * (the user asked for another attempt) a failure that passes by itself is not answered from the
   * memory; a refused key still is, as nothing the user can do on the card would change it.
   */
  recall(key: string, retry?: boolean): R | null;
  /** Remembers a failure, for as long as its kind deserves. Others (a bad photo...) are not. */
  remember(key: string, reason: R): void;
  /** Forgets it: the call just worked, or the user fixed something (their key tested fine). */
  forget(): void;
}

/**
 * The memory of the last failure of a provider's paid call (one per Vision searcher, one per AI
 * reviewer), in memory only: a restarted service worker simply tries again.
 */
export function createFailureMemo<R extends string>(now: () => number): FailureMemo<R> {
  let memo: { key: string; reason: R; until: number } | null = null;
  return {
    recall(key, retry = false) {
      if (!memo || memo.key !== key || now() >= memo.until) return null;
      if (retry && !isKeyFailure(memo.reason)) return null;
      return memo.reason;
    },
    remember(key, reason) {
      const ms = isKeyFailure(reason)
        ? KEY_FAILURE_MEMO_MS
        : TRANSIENT.includes(reason)
          ? TRANSIENT_FAILURE_MEMO_MS
          : 0;
      if (ms > 0) memo = { key, reason, until: now() + ms };
    },
    forget() {
      memo = null;
    },
  };
}
