import { render } from 'preact';
import { createBatch, type AnalyzeResult } from '../../lib/grid/batch';
import { BAR_HOST_TAG, createHost, createSharedStyles, type Host } from '../../lib/grid/host';
import {
  quickAnalysis,
  SEARCH_IMPOSSIBLE,
  type QuickAnalysisDeps,
  type QuickOutcome,
} from '../../lib/grid/quick-analysis';
import { createGridStore, viewOf, type CardView } from '../../lib/grid/store';
import { isShown } from '../../lib/grid/viewport';
import type { ImageGate } from '../../lib/gate';
import type { OptionsSection } from '../../lib/messages';
import { findResultsAnchor, readGridCard } from '../../lib/vinted/grid';
import { GridBar } from './GridBar';
import { createGridInjector, type LiveCard } from './injector';

export type { AnalyzeResult };

export interface GridControllerOptions {
  doc: Document;
  /** The CSS of the blocks, shared by all their shadow roots. */
  css: string;
  deps: QuickAnalysisDeps;
  openOptions(section: OptionsSection): void;
  /** The gate of the image search: `no_key` hides the bar. Never rejects. */
  askImageGate(): Promise<ImageGate>;
  /** Vision credits left, for the confirmation. Never rejects; null when unknown. */
  askRemaining(): Promise<number | null>;
  /** Runs `run` soon, once for a burst of calls. `requestAnimationFrame` by default. */
  schedule?(run: () => void): void;
  /** The pause between two cards of a batch. A timer by default. */
  sleep?(ms: number): Promise<void>;
  /** Whether a card shows in the window. The real layout by default. */
  isShown?(element: Element): boolean;
}

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
 * A card a batch may take: not analysed yet, or whose last attempt failed. A card without a photo
 * waits for a click (its thumbnail may load later), a batch would only go through it again.
 */
const IS_PENDING = (view: CardView) => view.status === 'idle' || view.status === 'error';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const inPageOrder = (a: LiveCard, b: LiveCard) =>
  a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

/**
 * The results-grid feature of a page: the blocks under the cards, what a click on one does, and the
 * bar above the results that does the same for every card in view. The state of the cards lives
 * here, in memory, for as long as the page does.
 */
export function createGridController(options: GridControllerOptions): GridController {
  const { doc } = options;
  const view = doc.defaultView;
  const schedule = options.schedule ?? ((run) => void requestAnimationFrame(run));
  const shown = options.isShown ?? isShown;
  const store = createGridStore();
  const styles = createSharedStyles(options.css);
  let disposed = false;
  /** What the background last said about the image search; the bar is not offered without a key. */
  let gate: ImageGate = 'no_key';
  let bar: Host | null = null;
  let barScheduled = false;

  const injector = createGridInjector({
    doc,
    store,
    styles,
    schedule: options.schedule,
    onAnalyze: (id) => void analyze(id),
    onOpenOptions: (section) => {
      options.openOptions(section);
      // The user is going to fix it: the next click asks again, whatever the page last showed.
      store.resetWhere(IS_BLOCKED);
    },
    onScan: () => requestBar(),
  });

  const batch = createBatch({
    analyze: (id) => analyze(id),
    sleep: options.sleep ?? wait,
    remaining: options.askRemaining,
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
    // The search itself is the freshest word on the key and the cap.
    if (outcome.status === 'needsKey') gate = 'no_key';
    else if (outcome.status === 'quota') gate = 'quota';
    else if (outcome.status === 'done' && gate === 'no_key') gate = 'ready';
    store.set(id, viewOf(outcome, read?.url ?? card.url));
    return outcome.status;
  }

  // ---- The bar above the results ------------------------------------------------------------

  /** The items in view that a batch would take, in page order, each once. */
  function pendingInView(): string[] {
    const ids = new Set<string>();
    for (const card of injector.cards().sort(inPageOrder)) {
      if (IS_PENDING(store.get(card.id)) && shown(card.element)) ids.add(card.id);
    }
    return [...ids];
  }

  function drawBar(host: Host, visibleCount: number) {
    render(
      <GridBar
        visibleCount={visibleCount}
        batch={batch.state()}
        onAsk={() => void batch.ask(pendingInView())}
        onLaunch={() => void batch.launch()}
        onCancel={() => batch.cancel()}
        onStop={() => batch.stop()}
      />,
      host.container,
    );
  }

  function hideBar() {
    if (bar?.element.isConnected) bar.element.remove();
  }

  function refreshBar() {
    if (disposed) return;
    const count = pendingInView().length;
    // A batch that is waiting or running keeps its bar, whatever the page scrolled to meanwhile.
    const wanted = batch.state().phase !== 'idle' || (gate !== 'no_key' && count > 0);
    if (!wanted) return hideBar();
    const wasRemoved = bar !== null && !bar.element.isConnected;
    bar ??= createHost(doc, BAR_HOST_TAG, styles, '0 0 12px');
    drawBar(bar, count);
    const anchor = findResultsAnchor(
      injector
        .cards()
        .sort(inPageOrder)
        .map((card) => card.element),
    );
    if (anchor && bar.element.nextElementSibling !== anchor) anchor.before(bar.element);
    // The same host, with the same shadow tree and batch state, goes back where it was.
    if (wasRemoved && bar.element.isConnected)
      console.debug('[Fripon] The page dropped the bar, put back.');
  }

  function requestBar() {
    if (barScheduled || disposed) return;
    barScheduled = true;
    schedule(() => {
      barScheduled = false;
      try {
        refreshBar();
      } catch (error) {
        // A failure here must neither stop the next refresh nor reach the page.
        console.warn('[Fripon] Could not update the bar.', error);
      }
    });
  }

  async function refreshGate() {
    const next = await options.askImageGate();
    if (disposed) return;
    gate = next;
    requestBar();
  }

  let lastPhase = batch.state().phase;
  batch.subscribe(() => {
    const phase = batch.state().phase;
    // A batch just ended: the cap or the key may be what stopped it, ask the background again.
    if (lastPhase === 'running' && phase === 'idle') void refreshGate();
    lastPhase = phase;
    requestBar();
  });
  store.subscribe(() => requestBar());

  const onVisibility = () => {
    if (doc.visibilityState === 'visible') void refreshGate();
  };
  const onViewChange = () => requestBar();

  return {
    start() {
      injector.start();
      void refreshGate();
      view?.addEventListener('scroll', onViewChange, { passive: true, capture: true });
      view?.addEventListener('resize', onViewChange, { passive: true });
      doc.addEventListener('visibilitychange', onVisibility);
    },
    rescan: () => injector.scan(),
    analyze,
    cards: () => injector.cards(),
    dispose() {
      disposed = true;
      batch.stop();
      view?.removeEventListener('scroll', onViewChange, { capture: true });
      view?.removeEventListener('resize', onViewChange);
      doc.removeEventListener('visibilitychange', onVisibility);
      hideBar();
      if (bar) render(null, bar.container);
      injector.dispose();
    },
  };
}
