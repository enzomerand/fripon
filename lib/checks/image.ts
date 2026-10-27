import { isKeyFailure } from '../google/refusal';
import type { VisionFailure } from '../google/vision';
import type { SearchImageResponse } from '../messages';
import type { CheckAction, CheckResult, ImageMatch } from '../model';

/** Why the reverse image search did not run. */
export type ImageCheckOffReason = 'no_key' | 'quota' | 'manual';

/** Free fallback: opens Google Lens on the listing photo, to search by hand. */
export function googleLensUrl(photoUrl: string): string {
  return `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(photoUrl)}`;
}

const OFF_DETAILS: Record<ImageCheckOffReason, string> = {
  no_key: 'Ajoute une clé Google pour retrouver la photo sur Shein, Temu…',
  quota: 'Plafond de recherches atteint, réessaie plus tard ou cherche toi-même avec Google Lens.',
  manual: "Tu as choisi l'analyse au clic : lance la recherche d'image quand tu veux.",
};

const OFF_TAGS: Record<ImageCheckOffReason, string> = {
  no_key: 'Désactivée',
  quota: 'Plafond atteint',
  manual: 'Au clic',
};

/** What the user can do about it. "manual" gets the button that runs the search. */
const OFF_ACTIONS: Record<ImageCheckOffReason, CheckAction> = {
  no_key: 'open_guide',
  quota: 'open_settings',
  manual: 'run_image_search',
};

/** The image row when the search did not run. */
export function imageCheckOff(reason: ImageCheckOffReason): CheckResult {
  return {
    id: 'image',
    status: 'off',
    tag: OFF_TAGS[reason],
    detail: OFF_DETAILS[reason],
    signals: [],
    action: OFF_ACTIONS[reason],
  };
}

/** The image row while the search runs (after a click in manual mode). */
export function imageCheckSearching(): CheckResult {
  return {
    id: 'image',
    status: 'off',
    tag: 'En cours',
    detail: 'Recherche en cours…',
    signals: [],
  };
}

/**
 * The image row for what the search found: a copy on a product page is red, only similar pages
 * are orange, nothing is green. The status and the platform come from the exact match when there
 * is one, whatever the order of `matches`.
 */
export function imageCheckForMatches(matches: ImageMatch[]): CheckResult {
  const exact = matches.find((match) => match.exact);
  const closest = exact ?? matches[0];
  if (!closest) {
    return {
      id: 'image',
      status: 'ok',
      tag: 'Introuvable',
      detail: 'Aucune trace de cette photo sur Shein, Temu, AliExpress…',
      signals: [],
    };
  }
  return {
    id: 'image',
    status: exact ? 'bad' : 'warn',
    tag: exact ? `Trouvée sur ${closest.platform}` : 'Photo proche',
    detail: exact
      ? `La même photo est en vente sur ${closest.platform}.`
      : `Une photo très proche existe sur ${closest.platform}.`,
    signals: [],
    matches,
  };
}

const KEY_REFUSED = 'Google refuse ta clé Vision : vérifie-la dans les réglages.';

const FAILURE_DETAILS: Record<VisionFailure, string> = {
  invalid: KEY_REFUSED,
  restricted: KEY_REFUSED,
  disabled: KEY_REFUSED,
  billing: KEY_REFUSED,
  quota: 'Google a atteint le quota de ta clé Vision, réessaie plus tard.',
  network: 'Google ne répond pas, réessaie plus tard.',
  photo: "La photo de l'annonce n'a pas pu être analysée.",
  unavailable: 'Google Vision est indisponible pour le moment.',
};

/** What the retry button of a failed search says: the action is the one of the "Au clic" button. */
const RETRY_SEARCH_LABEL = 'Réessayer la recherche';

/** Failures that may pass: trying again is worth a click (and a credit). */
const RETRYABLE_FAILURES: readonly VisionFailure[] = ['network', 'quota'];

/**
 * The image row when the search was tried and failed. A problem with the key sends the user to
 * the keys; Google not answering or a quota used up at Google may pass, so the row offers to
 * search again. A photo that could not be read does not: it fails the same way every time, and
 * each attempt would cost a credit.
 */
export function imageCheckFailed(reason: VisionFailure): CheckResult {
  const row: CheckResult = {
    id: 'image',
    status: 'off',
    tag: 'Recherche impossible',
    detail: FAILURE_DETAILS[reason],
    signals: [],
  };
  if (isKeyFailure(reason)) return { ...row, action: 'open_keys' };
  if (RETRYABLE_FAILURES.includes(reason)) {
    return { ...row, action: 'run_image_search', actionLabel: RETRY_SEARCH_LABEL };
  }
  return row;
}

/** The image row for the answer of the background to a `searchImage` request. */
export function imageCheckForSearch(response: SearchImageResponse): CheckResult {
  switch (response.status) {
    case 'ok':
      return imageCheckForMatches(response.matches);
    case 'no_key':
      return imageCheckOff('no_key');
    case 'quota':
      return imageCheckOff('quota');
    case 'not_cached':
      // Only asked for the cache (manual mode) and nothing was there: the row waits for a click.
      return imageCheckOff('manual');
    case 'error':
      return imageCheckFailed(response.reason);
  }
}
