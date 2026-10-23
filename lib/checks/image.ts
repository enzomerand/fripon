import type { ImageGate } from '../gate';
import type { CheckAction, CheckResult } from '../model';

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
    "Tu as choisi l'analyse au clic : le bouton pour lancer la recherche d'image arrive avec la prochaine version de Fripon.",
};

const OFF_TAGS: Record<ImageCheckOffReason, string> = {
  no_key: 'Désactivée',
  quota: 'Plafond atteint',
  manual: 'Désactivée',
};

/** What the user can do about it. "manual" gets its button when the search itself exists (lot 3). */
const OFF_ACTIONS: Partial<Record<ImageCheckOffReason, CheckAction>> = {
  no_key: 'open_guide',
  quota: 'open_settings',
};

/** The image check row when the search did not run. */
export function imageCheckOff(reason: ImageCheckOffReason): CheckResult {
  const action = OFF_ACTIONS[reason];
  return {
    id: 'image',
    status: 'off',
    tag: OFF_TAGS[reason],
    detail: OFF_DETAILS[reason],
    signals: [],
    ...(action && { action }),
  };
}

/**
 * The image row for what the background said about the keys. For "ready" the key is saved and the
 * search may run, but it is not built yet: lot 3 replaces that row with the real search.
 */
export function imageCheckForGate(gate: ImageGate): CheckResult {
  if (gate !== 'ready') return imageCheckOff(gate);
  return {
    id: 'image',
    status: 'off',
    tag: 'Clé prête',
    detail:
      "Ta clé est enregistrée : la recherche d'image arrive avec la prochaine version de Fripon.",
    signals: [],
  };
}
