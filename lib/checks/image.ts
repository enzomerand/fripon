import type { CheckResult } from '../model';

/** Why the reverse image search did not run. */
export type ImageCheckOffReason = 'no_key' | 'quota' | 'manual';

/** Free fallback: opens Google Lens on the listing photo, to search by hand. */
export function googleLensUrl(photoUrl: string): string {
  return `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(photoUrl)}`;
}

const OFF_DETAILS: Record<ImageCheckOffReason, string> = {
  no_key: 'Ajoute une clé Google pour retrouver la photo sur Shein, Temu…',
  quota: 'Plafond de recherches atteint, réessaie plus tard ou cherche toi-même avec Google Lens.',
  manual:
    'Recherche en mode manuel : lance-la quand tu veux, ou cherche toi-même avec Google Lens.',
};

/** The image check row when the search did not run. */
export function imageCheckOff(reason: ImageCheckOffReason): CheckResult {
  return {
    id: 'image',
    status: 'off',
    tag: 'Désactivée',
    detail: OFF_DETAILS[reason],
    signals: [],
  };
}
