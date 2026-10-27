import type { AiReviewInput } from '../ai/input';
import type { Gates } from '../gate';
import type { AiReviewResponse, SearchImageResponse } from '../messages';
import type { PendingSection } from '../options-nav';

/** The four things the background answers that depend on whose keys do the paid work. */
export interface PaidSteps {
  searchImage(photoUrl: string, cacheOnly: boolean, retry: boolean): Promise<SearchImageResponse>;
  aiReview(input: AiReviewInput, cacheOnly: boolean, retry: boolean): Promise<AiReviewResponse>;
  loadGates(): Promise<Gates>;
  loadVisionRemaining(): Promise<number | null>;
}

export interface RouterDeps {
  /** Whether a session is stored. A storage that cannot be read counts as signed out. */
  signedIn(): Promise<boolean>;
  /** Signed in: the Fripon server does the paid work. */
  cloud: PaidSteps;
  /** Signed out: the user's own Google keys, as before the subscription existed. */
  personal: PaidSteps;
}

/**
 * Signed in means the subscription only: no fallback to the user's own keys, and none the other
 * way round. The session is looked at on every call, so a sign-in or sign-out takes effect at the
 * next request, with no state to keep in step.
 */
export function createRouter(deps: RouterDeps): PaidSteps {
  const pick = async (): Promise<PaidSteps> =>
    (await deps.signedIn().catch(() => false)) ? deps.cloud : deps.personal;
  return {
    searchImage: async (photoUrl, cacheOnly, retry) =>
      (await pick()).searchImage(photoUrl, cacheOnly, retry),
    aiReview: async (input, cacheOnly, retry) => (await pick()).aiReview(input, cacheOnly, retry),
    loadGates: async () => (await pick()).loadGates(),
    loadVisionRemaining: async () => (await pick()).loadVisionRemaining(),
  };
}

/**
 * The options section a card button leads to. The guide, the keys and the credits are about the
 * user's own Google keys, which a signed-in account does not use: the subscription section is
 * where its quota and its plan are.
 */
export function sectionFor(
  signedIn: boolean,
  section: PendingSection | undefined,
): PendingSection | undefined {
  if (signedIn && (section === 'guide' || section === 'keys' || section === 'credits')) {
    return 'cloud';
  }
  return section;
}
