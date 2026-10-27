import { render } from 'preact';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { aiBlockFor, type AiBlock } from '../lib/ai/block';
import { imageBasis } from '../lib/ai/input';
import {
  AnalysisCancelledError,
  analyzeListing,
  askAiReview,
  searchPhoto,
  withAiReview,
  withImageSearch,
  type AiDeps,
  type AnalysisDeps,
  type AnalysisResult,
  type SearchDeps,
} from '../lib/analysis';
import { imageCheckSearching, imageSearchCanBeRetried } from '../lib/checks/image';
import type { Gate, Gates } from '../lib/gate';
import { sendMessage, type OptionsSection } from '../lib/messages';
import type { Listing } from '../lib/model';
import { waitFor } from '../lib/wait';
import { fetchSeller } from '../lib/vinted/api';
import { findAnchor } from '../lib/vinted/anchor';
import { VINTED_ITEM_MATCHES } from '../lib/vinted/domains';
import { itemIdFromUrl, readListing } from '../lib/vinted/listing-reader';
import { ListingCard, type CardState } from '../ui/ListingCard';
import '../ui/ListingCard.css';

/** How long to wait for Vinted to stream in the spot where the card goes. */
const ANCHOR_TIMEOUT_MS = 10_000;
/** How long to wait for the listing data (seller link, price...) once the card is shown. */
const LISTING_TIMEOUT_MS = 10_000;
const HOST_TAG = 'fripon-listing-card';
/** The host element is reset by WXT (`all: initial`): give it back a block box. */
const HOST_CSS = ':host { display: block !important; margin: 12px 0 !important; }';

const analysisDeps: AnalysisDeps = {
  fetchSeller,
  analyzeImage: (url) => sendMessage({ type: 'analyzeImage', url }),
};

const searchDeps: SearchDeps = {
  searchImage: (photoUrl, cacheOnly, retry) =>
    sendMessage({
      type: 'searchImage',
      photoUrl,
      ...(cacheOnly && { cacheOnly: true }),
      ...(retry && { retry: true }),
    }),
};

const aiDeps: AiDeps = {
  aiReview: (input, cacheOnly, retry) =>
    sendMessage({
      type: 'aiReview',
      input,
      ...(cacheOnly && { cacheOnly: true }),
      ...(retry && { retry: true }),
    }),
};

const GATE_WORDS: readonly Gate[] = ['ready', 'no_key', 'quota', 'manual'];
const NO_GATES: Gates = { image: 'no_key', ai: 'no_key' };

const wordOf = (gate: unknown): Gate =>
  GATE_WORDS.includes(gate as Gate) ? (gate as Gate) : 'no_key';

/**
 * What the background says about the paid steps. The keys never leave it: this is all we learn.
 * Any failure counts as "no key", the safe state in which nothing paid is attempted.
 */
async function askGates(): Promise<Gates> {
  try {
    const gates = await sendMessage({ type: 'getGates' });
    return { image: wordOf(gates?.image), ai: wordOf(gates?.ai) };
  } catch {
    return NO_GATES;
  }
}

function openOptions(section: OptionsSection) {
  void sendMessage({ type: 'openOptions', section }).catch(() => undefined);
}

type Ui = Awaited<ReturnType<typeof createShadowRootUi<HTMLElement>>>;

/** What the card currently shows, kept to redo the verdict once the paid steps answer. */
interface Analysed {
  listing: Listing;
  result: AnalysisResult;
  /** What the background said about the paid steps when the page opened (a display hint). */
  gates: Gates;
  /** The AI block of the expanded card, null when the card says nothing of the AI. */
  ai: AiBlock | null;
  /**
   * true while a search, or a review, that can spend is running (not the look in the cache): a
   * second one does not start. Apart on purpose: the retry of a search must never be ignored
   * because a review is on its way.
   */
  busyImage: boolean;
  busyAi: boolean;
  /**
   * true from a click until the review it may start has been asked: the review is sent with
   * `retry`. It comes from the user, never from the page asking again by itself.
   */
  retryAsked: boolean;
  /**
   * What the image search had found (`imageBasis`) when the review was last asked or answered,
   * null before any. A review is asked again only when this is no longer what the card shows.
   */
  aiBasis: string | null;
}

/**
 * auto: the steps the card starts by itself once it is shown. click: the button of the card (the
 * image row's, which starts the AI review along with it, or the AI block's). One code path for
 * both: automatic mode is a click nobody has to make.
 */
type Trigger = 'auto' | 'click';

/** Whether a step with this gate can really spend a credit. */
const canSpend = (gate: Gate) => gate === 'ready' || gate === 'manual';

/** Owns the card of this page: mounts it, updates it, and replaces it on a new run. */
function createCardController(ctx: ContentScriptContext) {
  let runId = 0;
  /** Item the current card belongs to, null when this page is not an item page. */
  let currentItemId: string | null = null;
  let ui: Ui | null = null;
  let container: HTMLElement | null = null;
  let keepAttached: MutationObserver | null = null;
  /** The finished analysis of the current run, null until there is one. */
  let analysed: Analysed | null = null;
  ctx.onInvalidated(() => stopKeepingAttached());

  function show(state: CardState) {
    if (!container) return;
    render(
      <ListingCard
        state={state}
        onRetry={() => void start()}
        onOpenOptions={openOptions}
        onRun={() => runPaidSteps('click')}
      />,
      container,
    );
  }

  /** Shows the current analysis; `searchingImage` puts the "search running" row in the image row's place. */
  function showAnalysed(current: Analysed, searchingImage = false) {
    const { listing, result } = current;
    // The click that runs the search starts the review too: its button gives way to the block
    // saying so, from the first render.
    const ai: AiBlock | null =
      searchingImage && current.ai?.status === 'waiting' && canSpend(current.gates.ai)
        ? { status: 'running' }
        : current.ai;
    show({
      status: 'done',
      listing,
      verdict: result.verdict,
      checks: searchingImage
        ? result.checks.map((check) => (check.id === 'image' ? imageCheckSearching() : check))
        : result.checks,
      ...(ai && { ai }),
    });
  }

  /** Starts the paid steps without waiting for them. Never rejects: a failure must not hurt the page. */
  function runPaidSteps(trigger: Trigger) {
    void paidSteps(trigger).catch((error: unknown) => {
      console.warn('[Fripon] The paid steps failed.', error);
    });
  }

  /**
   * The image search, then the AI review with every signal including the search's result, then the
   * verdict redone from the checks the page already has each time: no new seller request, no new
   * photo download, no free check run again.
   *
   * What the page asks follows the gates, but the background has the last word on keys and credits:
   * - ready: the real request, started as soon as the card shows (the rows already say it runs).
   * - no_key, quota: the same request. The background answers the same words without spending, or
   *   with a result when this listing was reviewed before.
   * - manual: by itself only a look in the cache (`lookup`), which costs nothing; the click sends
   *   the real request. A click starts the image search only when its row has the button (a manual
   *   search, or the retry of a failed one).
   *
   * The review always follows the image row: it is asked again whenever the search's result is not
   * the one the last review was based on (see `aiReviewSteps`).
   */
  async function paidSteps(trigger: Trigger) {
    const current = analysed;
    if (!current) return;
    const { gates } = current;
    if (trigger === 'click') current.retryAsked = true;
    const imageHasButton =
      current.result.checks.find((check) => check.id === 'image')?.action === 'run_image_search';
    const lookup = trigger === 'auto' && gates.image === 'manual';
    // A search already running is not started twice, and the review waits for its own turn.
    if (
      (trigger === 'auto' || imageHasButton) &&
      !(await imageSearchStep(current, lookup, trigger))
    ) {
      return;
    }
    await aiReviewSteps(current, trigger);
    // Unless a review that another call is running still has to use it.
    if (!current.busyAi) current.retryAsked = false;
  }

  /** false when the search was not started because another one is running. */
  async function imageSearchStep(current: Analysed, lookup: boolean, trigger: Trigger) {
    // Only a search that can spend keeps another one from starting: a look in the cache is quick
    // and free, and so is a request the gate says the background will refuse.
    const spends = !lookup && canSpend(current.gates.image);
    if (spends) {
      if (current.busyImage) return false;
      current.busyImage = true;
    }
    try {
      // The row already says "Recherche en cours…" when the search starts by itself; only a click
      // has to take the button's place.
      if (trigger === 'click') showAnalysed(current, true);
      // A click is the user asking for another attempt: no answer from the memory of a failure.
      const response = await searchPhoto(
        current.listing.photoUrls[0],
        searchDeps,
        lookup,
        trigger === 'click',
      );
      // A newer run (new item, bfcache restore) took the card over while the search ran.
      if (analysed !== current) return true;
      // A look in the cache only ever shows a result: a miss, a failure or a lost message leaves the
      // "Au clic" row alone (it is not a failed search), and so does a click that got there first.
      if (lookup && (current.busyImage || response.status !== 'ok')) return true;
      current.result = withImageSearch(current.result, response);
      showAnalysed(current);
      return true;
    } finally {
      if (spends) current.busyImage = false;
    }
  }

  /**
   * Asks for the AI review until it is based on what the image row shows now. A review that was
   * asked (or came from the cache) for another result of the search is stale: a click that ran the
   * search after a cached review, a retry that succeeded. Asking again has a new cache key, so it
   * may spend a credit, which is the point. A review is not asked again for the same result, even
   * after a failure (reload the page to try again).
   *
   * One review runs at a time. A second call while one is running just returns: the running one
   * looks at the image row when its answer comes, drops that answer if the row has changed since,
   * and asks again. Its busy flag is not the search's, so the retry of a search is never ignored.
   */
  async function aiReviewSteps(current: Analysed, trigger: Trigger) {
    const { gates } = current;
    const lookup = trigger === 'auto' && gates.ai === 'manual';
    // A click only starts what a credit can pay for; the rest is the background's to refuse.
    if (trigger === 'click' && !canSpend(gates.ai)) return;
    if (!lookup) {
      if (current.busyAi) return;
      current.busyAi = true;
    }
    try {
      for (;;) {
        if (analysed !== current || ctx.isInvalid) return;
        // A failed search that offers its retry is not final: the review waits for the row to be
        // (a result, no key, no credits left, or a failure that a new search would not change).
        if (imageSearchCanBeRetried(current.result.checks.find((c) => c.id === 'image'))) return;
        const basis = imageBasis(current.result.rawChecks);
        if (current.aiBasis === basis) return;
        if (!lookup) {
          current.aiBasis = basis;
          // With no key or no credits left the answer is immediate and shows nothing: no flash of
          // "L'IA lit l'annonce…" then.
          if (canSpend(gates.ai)) {
            current.ai = { status: 'running' };
            showAnalysed(current);
          }
        }
        // Another attempt only when the user asked for one, never because the page asks again.
        const retry = !lookup && current.retryAsked;
        current.retryAsked = false;
        const response = await askAiReview(current.listing, current.result, aiDeps, lookup, retry);
        if (analysed !== current) return;
        const stale = basis !== imageBasis(current.result.rawChecks);
        if (lookup) {
          // A look in the cache only ever shows a review, for the image row it was asked about.
          if (current.busyAi || stale || response.status !== 'ok') return;
          current.aiBasis = basis;
        } else if (stale) {
          continue;
        }
        current.result = withAiReview(current.result, response);
        current.ai = aiBlockFor(response);
        showAnalysed(current);
        if (lookup) return;
      }
    } finally {
      if (!lookup) current.busyAi = false;
    }
  }

  function stopKeepingAttached() {
    keepAttached?.disconnect();
  }

  /**
   * Vinted re-renders the item sidebar after load (seen ~0.3 s and ~2 s in), which drops the card
   * with it: move the same host, shadow tree and state included, next to the new anchor.
   */
  function keepCardAttached(host: HTMLElement) {
    keepAttached = new MutationObserver(() => {
      // A card moved onto another item's page before `wxt:locationchange` disposes it would lie.
      if (host.isConnected || itemIdFromUrl(location.href) !== currentItemId) return;
      const anchor = findAnchor(document);
      if (!anchor) return;
      if (anchor.position === 'after') anchor.element.after(host);
      else anchor.element.before(host);
    });
    keepAttached.observe(document.body, { childList: true, subtree: true });
  }

  function dispose() {
    // First, or removing the card below would put it straight back.
    stopKeepingAttached();
    ui?.remove();
    ui = null;
    container = null;
    analysed = null;
    // A card left by a previous run of this script (extension reload, bfcache).
    for (const stale of document.querySelectorAll(HOST_TAG)) stale.remove();
  }

  /** False when a newer run took over while the shadow root UI was being created. */
  async function mount(id: number, anchorElement: Element, position: 'after' | 'before') {
    const created = await createShadowRootUi(ctx, {
      name: HOST_TAG,
      position: 'inline',
      anchor: anchorElement,
      append: position,
      css: HOST_CSS,
      onMount: (uiContainer) => {
        container = uiContainer;
        return uiContainer;
      },
      onRemove: (mounted) => {
        if (mounted) render(null, mounted);
      },
    });
    if (id !== runId) {
      created.remove();
      return false;
    }
    ui = created;
    created.mount();
    keepCardAttached(created.shadowHost);
    return true;
  }

  async function run(id: number) {
    const anchor = await waitFor(() => findAnchor(document), { timeoutMs: ANCHOR_TIMEOUT_MS });
    if (id !== runId) return;
    if (!anchor) {
      console.warn('[Fripon] No spot found for the card within the timeout, nothing displayed.');
      return;
    }

    if (!(await mount(id, anchor.element, anchor.position))) return;
    show({ status: 'loading' });

    // Asked while the page is still being read; it never rejects.
    const pendingGates = askGates();
    const listing = await waitFor(() => readListing(document, location.href), {
      timeoutMs: LISTING_TIMEOUT_MS,
    });
    if (id !== runId) return;
    if (!listing) {
      console.warn('[Fripon] Could not read the listing from the page.');
      show({
        status: 'error',
        message: "Je n'arrive pas à lire cette annonce, Vinted a peut-être changé sa page.",
      });
      return;
    }

    const gates = await pendingGates;
    const isCancelled = () => id !== runId || ctx.isInvalid;
    const result = await analyzeListing(listing, analysisDeps, {
      imageGate: gates.image,
      // A superseded run must not send further requests or download further photos.
      isCancelled,
    });
    if (id !== runId) return;
    analysed = {
      listing,
      result,
      gates,
      // The button of the "Au clic" mode; otherwise the block appears when the review starts, which
      // is after the image search is final.
      ai: gates.ai === 'manual' ? { status: 'waiting' } : null,
      busyImage: false,
      busyAi: false,
      retryAsked: false,
      aiBasis: null,
    };
    showAnalysed(analysed);
    // The card does not wait for Google. The paid steps start only now, and only for a run that is
    // still current: a superseded run (new item, bfcache restore, invalidated script) spends nothing.
    if (!isCancelled()) runPaidSteps('auto');
  }

  /** (Re)starts the whole run. Never rejects: the page must not be affected by a failure here. */
  async function start() {
    const id = ++runId;
    try {
      dispose();
      currentItemId = itemIdFromUrl(location.href);
      await run(id);
    } catch (error) {
      if (error instanceof AnalysisCancelledError) return;
      console.warn('[Fripon] Analysis failed.', error);
      if (id !== runId) return;
      try {
        show({
          status: 'error',
          message: 'Une erreur est survenue pendant l’analyse, réessaie dans un instant.',
        });
      } catch {
        // Nothing more can be done for the page.
      }
    }
  }

  /**
   * Vinted reloads its pages today, but if it ever navigates in place the card must follow:
   * a new item gets a new analysis, any other page loses the card.
   */
  function handleLocationChange(newUrl: URL) {
    try {
      const nextId = itemIdFromUrl(newUrl.href);
      if (nextId === currentItemId) return;
      if (nextId === null) {
        runId++; // abandon any run still going
        currentItemId = null;
        dispose();
        return;
      }
      void start();
    } catch (error) {
      console.warn('[Fripon] Could not follow the navigation.', error);
    }
  }

  return { start, handleLocationChange };
}

export default defineContentScript({
  matches: VINTED_ITEM_MATCHES,
  cssInjectionMode: 'ui',
  main(ctx) {
    const card = createCardController(ctx);
    void card.start();
    // Back / forward can restore the page from the bfcache without reloading the script's world:
    // run again so the card reflects the restored page.
    ctx.addEventListener(window, 'pageshow', (event) => {
      if (event.persisted) void card.start();
    });
    ctx.addEventListener(window, 'wxt:locationchange', (event) => {
      card.handleLocationChange(event.newUrl);
    });
  },
});
