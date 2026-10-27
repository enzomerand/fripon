import { render } from 'preact';
import { BUTTON_HOST_TAG, createHost, type Host, type SharedStyles } from '../../lib/grid/host';
import type { GridStore } from '../../lib/grid/store';
import type { OptionsSection } from '../../lib/messages';
import { findCardRoots, readGridCard, type GridCard } from '../../lib/vinted/grid';
import { GRID_SELECTORS } from '../../lib/vinted/selectors';
import { GridButton } from './GridButton';

export interface InjectorOptions {
  doc: Document;
  store: GridStore;
  styles: SharedStyles;
  /** The user clicked the button of the card of item `id`. */
  onAnalyze(id: string): void;
  onOpenOptions(section: OptionsSection): void;
  /** Called after every pass over the page, with the cards as they are then. */
  onScan?(): void;
  /** Runs `run` soon, once for a burst of calls to the same scheduler. `requestAnimationFrame` by default. */
  schedule?(run: () => void): void;
}

/** A result card of the page that carries a Fripon block. */
export interface LiveCard {
  id: string;
  url: string;
  /** The card's root element. */
  element: Element;
}

export interface GridInjector {
  /** One idempotent pass: a block under every whole card that lacks one, put back where one was lost. */
  scan(): void;
  /** Scans now, then again after every change of the page (throttled). */
  start(): void;
  /** The cards of the page that are in it right now. */
  cards(): LiveCard[];
  /** Removes every block and stops watching. */
  dispose(): void;
}

interface Entry extends LiveCard {
  title: string;
  host: Host;
}

/**
 * Puts the Fripon block under each result card of the page, and keeps it there.
 *
 * The page is redrawn under our feet: the home feed replaces its content ~0.4 s after loading, a
 * pagination swaps every card, React may drop a node it did not put there. So the pass is
 * idempotent and runs after every change (one per frame at most): a card that has its block is left
 * alone, one that lost it gets the same block back, a new one gets a new block. What a block shows
 * comes from the store, by item id, so a card drawn again finds its verdict again.
 */
export function createGridInjector(options: InjectorOptions): GridInjector {
  const { doc, store, styles } = options;
  const schedule = options.schedule ?? ((run) => void requestAnimationFrame(run));
  /** Card element -> its block. A WeakMap: a card the page dropped takes its entry with it. */
  const byCard = new WeakMap<Element, Entry>();
  const live = new Set<Entry>();
  let observer: MutationObserver | null = null;
  let scheduled = false;
  let disposed = false;
  const unsubscribe = store.subscribe((id) => {
    for (const entry of live) if (entry.id === id) draw(entry);
  });

  function draw(entry: Entry) {
    render(
      <GridButton
        view={store.get(entry.id)}
        title={entry.title}
        onAnalyze={() => options.onAnalyze(entry.id)}
        onOpenOptions={options.onOpenOptions}
      />,
      entry.host.container,
    );
  }

  function create(card: GridCard): Entry {
    return {
      id: card.id,
      url: card.url,
      element: card.element,
      title: card.title,
      host: createHost(doc, BUTTON_HOST_TAG, styles),
    };
  }

  /** Right after the description block of the card, below the price and the size. */
  function place(entry: Entry, anchor: Element) {
    if (entry.host.element.previousElementSibling !== anchor) anchor.after(entry.host.element);
  }

  function track(entry: Entry) {
    if (live.has(entry)) return;
    live.add(entry);
    draw(entry);
  }

  function scan() {
    if (disposed) return;
    for (const root of findCardRoots(doc)) {
      const known = byCard.get(root);
      if (known) {
        track(known);
        const anchor = root.querySelector(GRID_SELECTORS.description);
        if (anchor) place(known, anchor);
        continue;
      }
      // A card still being drawn has no description block yet: the next pass takes it.
      const card = readGridCard(root);
      if (!card) continue;
      const entry = create(card);
      byCard.set(root, entry);
      track(entry);
      place(entry, card.anchor);
    }
    for (const entry of live) {
      if (entry.element.isConnected) continue;
      live.delete(entry);
      render(null, entry.host.container);
      entry.host.element.remove();
    }
    options.onScan?.();
  }

  function request() {
    if (scheduled || disposed) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      scan();
    });
  }

  return {
    scan,
    start() {
      scan();
      if (observer || disposed) return;
      observer = new MutationObserver(request);
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    },
    cards: () => [...live].map(({ id, url, element }) => ({ id, url, element })),
    dispose() {
      disposed = true;
      observer?.disconnect();
      observer = null;
      unsubscribe();
      for (const entry of live) {
        render(null, entry.host.container);
        entry.host.element.remove();
      }
      live.clear();
    },
  };
}
