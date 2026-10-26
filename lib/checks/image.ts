import type { SearchImageFailure, SearchImageResponse } from '../messages';
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
 * The image row for what the search found. `matches` come exact first (see `parseWebDetection`):
 * a copy on a product page is red, only similar pages are orange, nothing is green.
 */
export function imageCheckForMatches(matches: ImageMatch[]): CheckResult {
  const first = matches[0];
  if (!first) {
    return {
      id: 'image',
      status: 'ok',
      tag: 'Introuvable',
      detail: 'Aucune trace de cette photo sur Shein, Temu, AliExpress…',
      signals: [],
    };
  }
  const exact = first.exact;
  return {
    id: 'image',
    status: exact ? 'bad' : 'warn',
    tag: exact ? `Trouvée sur ${first.platform}` : 'Photo proche',
    detail: exact
      ? `La même photo est en vente sur ${first.platform}.`
      : `Une photo très proche existe sur ${first.platform}.`,
    signals: [],
    matches,
  };
}

const KEY_REFUSED = 'Google refuse ta clé Vision : vérifie-la dans les réglages.';

const FAILURE_DETAILS: Record<SearchImageFailure, string> = {
  invalid: KEY_REFUSED,
  restricted: KEY_REFUSED,
  disabled: KEY_REFUSED,
  billing: KEY_REFUSED,
  quota: 'Google a atteint le quota de ta clé Vision, réessaie plus tard.',
  network: 'Google ne répond pas, réessaie plus tard.',
  photo: "La photo de l'annonce n'a pas pu être analysée, réessaie plus tard.",
};

/** Failures that come from the key or its project: the user can fix them in the settings. */
const KEY_FAILURES: readonly SearchImageFailure[] = [
  'invalid',
  'restricted',
  'disabled',
  'billing',
];

/** The image row when the search was tried and failed. */
export function imageCheckFailed(reason: SearchImageFailure): CheckResult {
  return {
    id: 'image',
    status: 'off',
    tag: 'Recherche impossible',
    detail: FAILURE_DETAILS[reason],
    signals: [],
    ...(KEY_FAILURES.includes(reason) && { action: 'open_keys' as const }),
  };
}

/** The image row for the answer of the background to a `searchImage` request. */
export function imageCheckForSearch(response: SearchImageResponse): CheckResult {
  switch (response.status) {
    case 'ok':
      return Array.isArray(response.matches)
        ? imageCheckForMatches(response.matches)
        : imageCheckFailed('network');
    case 'no_key':
      return imageCheckOff('no_key');
    case 'quota':
      return imageCheckOff('quota');
    case 'error':
      return imageCheckFailed(response.reason);
    default:
      // An answer this version does not know: the safest reading is "did not work".
      return imageCheckFailed('network');
  }
}
