import type { CompactVerdict, KeySection, QuickOutcome } from './quick-analysis';

/**
 * What the Fripon block of one result card shows. Kept per item id, not per card element: Vinted
 * redraws cards (the home feed does it ~0.4 s after loading, a pagination replaces them), and the
 * new card must find the verdict of its item again.
 */
export type CardView =
  | { status: 'idle' }
  | { status: 'running' }
  /** `url`: the item page, where the full analysis is. */
  | { status: 'done'; verdict: CompactVerdict; url: string }
  | { status: 'needsKey'; section: KeySection }
  | { status: 'quota' }
  | { status: 'error'; line: string };

export const IDLE: CardView = { status: 'idle' };

/** The view that goes with the end of a reduced analysis. */
export function viewOf(outcome: QuickOutcome, itemUrl: string): CardView {
  return outcome.status === 'done'
    ? { status: 'done', verdict: outcome.verdict, url: itemUrl }
    : outcome;
}

/** Called with the id whose view changed. */
export type StoreListener = (id: string) => void;

/** The views of this page's cards, by item id. */
export interface GridStore {
  /** `idle` for an item nobody has touched. */
  get(id: string): CardView;
  set(id: string, view: CardView): void;
  /** Puts back to `idle` every card whose view `matches`. */
  resetWhere(matches: (view: CardView) => boolean): void;
  subscribe(listener: StoreListener): () => void;
}

export function createGridStore(): GridStore {
  const views = new Map<string, CardView>();
  const listeners = new Set<StoreListener>();
  const notify = (id: string) => {
    for (const listener of [...listeners]) listener(id);
  };

  return {
    get: (id) => views.get(id) ?? IDLE,
    set(id, view) {
      if (view.status === 'idle') views.delete(id);
      else views.set(id, view);
      notify(id);
    },
    resetWhere(matches) {
      for (const [id, view] of [...views]) {
        if (!matches(view)) continue;
        views.delete(id);
        notify(id);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
