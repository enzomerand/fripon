import type { CardView } from '../../lib/grid/store';
import type { OptionsSection } from '../../lib/messages';
import { LEVEL_COLOUR } from '../verdict-colour';

export interface GridButtonProps {
  view: CardView;
  /** The title of the item, for the accessible name of the button. */
  title: string;
  onAnalyze: () => void;
  onOpenOptions: (section: OptionsSection) => void;
}

export const ANALYZE_LABEL = 'Analyser';
export const RUNNING_LABEL = 'Analyse…';
export const GUIDE_LABEL = 'Activer en 2 minutes';
export const KEYS_LABEL = 'Vérifier ma clé';
export const QUOTA_LABEL = 'Plafond atteint';
export const RETRY_LABEL = 'Réessayer';
export const OPEN_FULL_ANALYSIS = "Ouvrir l'analyse complète";

/**
 * A click on the block must never reach the card: its link covers the whole card and would open
 * the item. The verdict is the one exception, it is a link to that item and keeps its own click.
 */
const press = (action: () => void) => (event: Event) => {
  event.preventDefault();
  event.stopPropagation();
  action();
};
const keepOffTheCard = (event: Event) => event.stopPropagation();

function analyzeName(title: string): string {
  return title ? `Analyser « ${title} » avec Fripon` : 'Analyser cette annonce avec Fripon';
}

/** The Fripon block under a result card: the button, then the compact verdict that replaces it. */
export function GridButton({ view, title, onAnalyze, onOpenOptions }: GridButtonProps) {
  return (
    <div class="fripon-grid" aria-live="polite">
      <Body view={view} title={title} onAnalyze={onAnalyze} onOpenOptions={onOpenOptions} />
    </div>
  );
}

function Body({ view, title, onAnalyze, onOpenOptions }: GridButtonProps) {
  switch (view.status) {
    case 'idle':
      return (
        <button
          type="button"
          class="fripon-grid__button"
          aria-label={analyzeName(title)}
          onClick={press(onAnalyze)}
        >
          <span aria-hidden="true">🦊</span> {ANALYZE_LABEL}
        </button>
      );
    case 'running':
      // Not `disabled`: a disabled button drops the focus the click gave it.
      return (
        <button
          type="button"
          class="fripon-grid__button fripon-grid__button--busy"
          aria-disabled="true"
          aria-busy="true"
          onClick={press(() => undefined)}
        >
          <span aria-hidden="true">⏳</span> {RUNNING_LABEL}
        </button>
      );
    case 'done': {
      const { verdict } = view;
      return (
        <a
          class={`fripon-grid__result fripon-grid__result--${LEVEL_COLOUR[verdict.level]}`}
          href={view.url}
          title={OPEN_FULL_ANALYSIS}
          aria-label={`${verdict.title}. ${verdict.line}. ${OPEN_FULL_ANALYSIS}.`}
          onClick={keepOffTheCard}
        >
          <span class="fripon-grid__title">
            <span class="fripon-grid__dot" aria-hidden="true" />
            {verdict.title}
          </span>
          <span class="fripon-grid__line">{verdict.line}</span>
        </a>
      );
    }
    case 'needsKey':
      return (
        <button
          type="button"
          class="fripon-grid__button"
          onClick={press(() => onOpenOptions(view.section))}
        >
          {view.section === 'keys' ? KEYS_LABEL : GUIDE_LABEL}
        </button>
      );
    case 'quota':
      return (
        <button
          type="button"
          class="fripon-grid__button fripon-grid__button--quiet"
          onClick={press(() => onOpenOptions('credits'))}
        >
          {QUOTA_LABEL}
        </button>
      );
    case 'error':
      return (
        <>
          <p class="fripon-grid__note">{view.line}</p>
          <button type="button" class="fripon-grid__button" onClick={press(onAnalyze)}>
            {RETRY_LABEL}
          </button>
        </>
      );
  }
}
