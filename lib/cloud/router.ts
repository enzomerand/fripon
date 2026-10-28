import type { AiReviewInput } from '../ai/input';
import type { Gate, Gates } from '../gate';
import type { AiReviewResponse, SearchImageResponse } from '../messages';
import type { PendingSection } from '../options-nav';
import type { SessionState } from './session';

/** The four things the background answers that depend on whose keys do the paid work. */
export interface PaidSteps {
  searchImage(photoUrl: string, cacheOnly: boolean, retry: boolean): Promise<SearchImageResponse>;
  aiReview(input: AiReviewInput, cacheOnly: boolean, retry: boolean): Promise<AiReviewResponse>;
  loadGates(): Promise<Gates>;
  loadVisionRemaining(): Promise<number | null>;
}

export interface RouterDeps {
  /** Where the session stands. A storage that cannot be read counts as signed out. */
  sessionState(): Promise<SessionState>;
  /** Signed in: the Fripon server does the paid work. */
  cloud: PaidSteps;
  /** Signed out (or expired): the user's own Google keys, as before the subscription existed. */
  personal: PaidSteps;
}

const expiredGate = (gate: Gate): Gate => (gate === 'no_key' ? 'expired' : gate);

/**
 * Signed in means the subscription only: no fallback to the user's own keys, and none the other
 * way round. The session is looked at on every call, so a sign-in or sign-out takes effect at the
 * next request, with no state to keep in step.
 *
 * An expired session (the server refused the token) is the personal mode in what it does, so keys
 * the user has kept still work. What changes is what it says about a missing key: a subscriber
 * whose session ended is not asked to add a Google key, so the answers and the gates say `expired`
 * where they would say `no_key`.
 */
export function createRouter(deps: RouterDeps): PaidSteps {
  const state = (): Promise<SessionState> =>
    deps.sessionState().catch((): SessionState => 'signed_out');
  return {
    searchImage: async (photoUrl, cacheOnly, retry) => {
      const mode = await state();
      if (mode === 'signed_in') return deps.cloud.searchImage(photoUrl, cacheOnly, retry);
      const answer = await deps.personal.searchImage(photoUrl, cacheOnly, retry);
      return mode === 'expired' && answer.status === 'no_key' ? { status: 'expired' } : answer;
    },
    aiReview: async (input, cacheOnly, retry) => {
      const mode = await state();
      if (mode === 'signed_in') return deps.cloud.aiReview(input, cacheOnly, retry);
      const answer = await deps.personal.aiReview(input, cacheOnly, retry);
      return mode === 'expired' && answer.status === 'no_key' ? { status: 'expired' } : answer;
    },
    loadGates: async () => {
      const mode = await state();
      if (mode === 'signed_in') return deps.cloud.loadGates();
      const gates = await deps.personal.loadGates();
      return mode === 'expired'
        ? { image: expiredGate(gates.image), ai: expiredGate(gates.ai) }
        : gates;
    },
    loadVisionRemaining: async () =>
      ((await state()) === 'signed_in' ? deps.cloud : deps.personal).loadVisionRemaining(),
  };
}

/**
 * The options section a card button leads to. The guide, the keys and the credits are about the
 * user's own Google keys, which a subscriber does not use: the subscription section is where to
 * sign in again (expired session) and where the quota and the plan are (signed in).
 */
export function sectionFor(
  state: SessionState,
  section: PendingSection | undefined,
): PendingSection | undefined {
  if (
    state !== 'signed_out' &&
    (section === 'guide' || section === 'keys' || section === 'credits')
  ) {
    return 'cloud';
  }
  return section;
}
