import type { GeminiFailure } from '../google/gemini';
import { isKeyFailure } from '../google/refusal';
import type { AiReviewResponse } from '../messages';

/**
 * What the AI block of the card shows. No block at all (no key, nothing in the cache) is `null`,
 * never a state of its own.
 * - waiting: "Au clic" mode, the review starts with a click.
 * - running: the review is on its way.
 * - done: the summary the AI wrote.
 * - failed: a short neutral line; `open_keys` adds the button that leads to the keys, `open_cloud`
 *   the one that leads to the subscription.
 */
export type AiBlock =
  | { status: 'waiting' }
  | { status: 'running' }
  | { status: 'done'; summary: string }
  | { status: 'failed'; message: string; action?: 'open_keys' | 'open_cloud' };

/** The subscription has nothing left: the month, a daily cap or the trial, not only "today". */
const CLOUD_QUOTA = "Tu n'as plus d'analyses disponibles.";

const KEY_REFUSED = 'Google refuse ta clé Gemini : vérifie-la dans les réglages.';

const FAILURE_LINES: Record<GeminiFailure | 'review_limit', string> = {
  invalid: KEY_REFUSED,
  restricted: KEY_REFUSED,
  disabled: KEY_REFUSED,
  billing: KEY_REFUSED,
  quota: 'Google a atteint la limite de ta clé Gemini, réessaie plus tard.',
  network: "L'IA ne répond pas pour l'instant.",
  photo: "L'IA n'a pas pu lire la photo de l'annonce.",
  unavailable: 'Gemini est indisponible pour le moment.',
  invalid_answer: "L'IA a donné une réponse inutilisable.",
  review_limit: "Tu as déjà demandé 3 avis de l'IA pour cette annonce ce mois-ci.",
};

/**
 * The block for what the background answered. `null` when the answer shows nothing: no Gemini key
 * (the card then says nothing of the AI at all), an expired subscription session (the image row
 * above already says so, with its button) or a look in the cache that found nothing.
 */
export function aiBlockFor(response: AiReviewResponse): AiBlock | null {
  switch (response.status) {
    case 'ok':
      return { status: 'done', summary: response.review.summary };
    case 'no_key':
    case 'expired':
    case 'not_cached':
      return null;
    case 'quota':
      return response.source === 'cloud'
        ? { status: 'failed', message: CLOUD_QUOTA, action: 'open_cloud' }
        : {
            status: 'failed',
            message: "Le plafond d'avis de l'IA est atteint pour aujourd'hui.",
          };
    case 'error': {
      const message = FAILURE_LINES[response.reason];
      return isKeyFailure(response.reason)
        ? { status: 'failed', message, action: 'open_keys' }
        : { status: 'failed', message };
    }
  }
}
