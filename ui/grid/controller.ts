import { createSharedStyles } from '../../lib/grid/host';
import {
  quickAnalysis,
  SEARCH_IMPOSSIBLE,
  type QuickAnalysisDeps,
  type QuickOutcome,
} from '../../lib/grid/quick-analysis';
import { createGridStore, viewOf, type CardView } from '../../lib/grid/store';
import type { OptionsSection } from '../../lib/messages';
import { readGridCard } from '../../lib/vinted/grid';
import { createGridInjector, type LiveCard } from './injector';

export interface GridControllerOptions {
  doc: Document;
  /** The CSS of the blocks, shared by all their shadow roots. */
  css: string;
  deps: QuickAnalysisDeps;
  openOptions(section: OptionsSection): void;
  schedule?(run: () => void): void;
}

/** How a call to `analyze` ended: the outcome of the analysis, or `skipped` when none ran. */
export type AnalyzeResult = QuickOutcome['status'] | 'skipped';

export interface GridController {
  start(): void;
  /** One more pass over the page (bfcache restore, in-page navigation). */
  rescan(): void;
  /** Analyses the card of item `id`, as if its button was clicked. Never rejects. */
  analyze(id: string): Promise<AnalyzeResult>;
  cards(): LiveCard[];
  dispose(): void;
}

const RUNNING: CardView = { status: 'running' };
const IS_BLOCKED = (view: CardView) => view.status === 'needsKey' || view.status === 'quota';

/**
 * The results-grid feature of a page: the blocks under the cards, and what a click on one does.
 * The state of the cards lives here, in memory, for as long as the page does.
 */
export function createGridController(options: GridControllerOptions): GridController {
  const store = createGridStore();
  let disposed = false;

  const injector = createGridInjector({
    doc: options.doc,
    store,
    styles: createSharedStyles(options.css),
    schedule: options.schedule,
    onAnalyze: (id) => void analyze(id),
    onOpenOptions: (section) => {
      options.openOptions(section);
      // The user is going to fix it: the next click asks again, whatever the page last showed.
      store.resetWhere(IS_BLOCKED);
    },
  });

  async function analyze(id: string): Promise<AnalyzeResult> {
    if (disposed) return 'skipped';
    const card = injector.cards().find((live) => live.id === id);
    const before = store.get(id);
    // A card that is gone from the page, one that is being analysed or one that has its verdict.
    if (!card || before.status === 'running' || before.status === 'done') return 'skipped';

    // Read again now: the thumbnail of a card that was still loading is there by the time of a click.
    const read = readGridCard(card.element);
    store.set(id, RUNNING);
    let outcome: QuickOutcome;
    try {
      outcome = await quickAnalysis(
        read?.photoUrl ?? null,
        options.deps,
        before.status === 'error',
      );
    } catch {
      // `quickAnalysis` never rejects; a card must not stay "running" if it ever does.
      outcome = { status: 'error', line: SEARCH_IMPOSSIBLE };
    }
    if (disposed) return 'skipped';
    store.set(id, viewOf(outcome, read?.url ?? card.url));
    return outcome.status;
  }

  return {
    start: () => injector.start(),
    rescan: () => injector.scan(),
    analyze,
    cards: () => injector.cards(),
    dispose() {
      disposed = true;
      injector.dispose();
    },
  };
}
