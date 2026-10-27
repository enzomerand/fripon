import type { BatchEnd, BatchState } from '../../lib/grid/batch';
import { press } from './press';

export interface GridBarProps {
  /** Cards in view that are not analysed yet: what a batch would start with. */
  visibleCount: number;
  batch: BatchState;
  onAsk: () => void;
  onLaunch: () => void;
  onCancel: () => void;
  onStop: () => void;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

export const analyzeAllLabel = (count: number) =>
  count === 1 ? "Analyser l'article visible" : `Analyser les ${count} articles visibles`;

/** « Jusqu'à N crédits Vision (il t'en reste M ce mois-ci). », without the part about M when it is not known. */
export function confirmText(total: number, remaining: number | null): string {
  const cost = `Jusqu'à ${total} ${plural(total, 'crédit', 'crédits')} Vision`;
  return remaining === null ? `${cost}.` : `${cost} (il t'en reste ${remaining} ce mois-ci).`;
}

export const progressText = (position: number, total: number) =>
  `Analyse en cours : ${position} / ${total}`;
export const STOPPING_TEXT = 'Arrêt en cours…';

/** What to tell the user about a batch that did not go through to the end, null when nothing. */
export function endNotice(end: BatchEnd | null): string | null {
  switch (end?.reason) {
    case 'quota':
      return "Plafond atteint : les articles restants n'ont pas été analysés.";
    case 'needsKey':
      return "Clé Google à vérifier : l'analyse s'est arrêtée.";
    case 'failures':
      return "Plusieurs recherches ont échoué : l'analyse s'est arrêtée, réessaie dans un instant.";
    case 'stopped':
      return `Analyse arrêtée après ${end.analysed} ${plural(end.analysed, 'article', 'articles')}.`;
    default:
      return null;
  }
}

/** The bar above the results: the button for the visible cards, its confirmation, its progress. */
export function GridBar({ visibleCount, batch, onAsk, onLaunch, onCancel, onStop }: GridBarProps) {
  return (
    <div class="fripon-bar" role="region" aria-label="Fripon : analyse des articles visibles">
      {batch.phase === 'confirm' && (
        <>
          <p class="fripon-bar__text" role="alert">
            {confirmText(batch.total, batch.remaining)}
          </p>
          <div class="fripon-bar__actions">
            <button
              type="button"
              class="fripon-bar__button fripon-bar__button--primary"
              onClick={press(onLaunch)}
            >
              Lancer
            </button>
            <button type="button" class="fripon-bar__button" onClick={press(onCancel)}>
              Annuler
            </button>
          </div>
        </>
      )}
      {batch.phase === 'running' && (
        <>
          <p class="fripon-bar__text" role="status">
            {batch.stopping ? STOPPING_TEXT : progressText(batch.position, batch.total)}
          </p>
          <div class="fripon-bar__actions">
            <button
              type="button"
              class="fripon-bar__button"
              aria-disabled={batch.stopping ? 'true' : undefined}
              onClick={press(onStop)}
            >
              Arrêter
            </button>
          </div>
        </>
      )}
      {batch.phase === 'idle' && (
        <>
          {endNotice(batch.last) && (
            <p class="fripon-bar__text fripon-bar__text--note" role="status">
              {endNotice(batch.last)}
            </p>
          )}
          <button
            type="button"
            class="fripon-bar__button fripon-bar__button--primary"
            onClick={press(onAsk)}
          >
            <span aria-hidden="true">🦊</span> {analyzeAllLabel(visibleCount)}
          </button>
        </>
      )}
    </div>
  );
}
