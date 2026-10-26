import { render } from 'preact';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { AnalysisCancelledError, analyzeListing, type AnalysisDeps } from '../lib/analysis';
import type { ImageGate } from '../lib/gate';
import { sendMessage, type OptionsSection } from '../lib/messages';
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

const IMAGE_GATES: readonly ImageGate[] = ['ready', 'no_key', 'quota', 'manual'];

/**
 * What the background says about the image search. The keys never leave it: this is all we learn.
 * Any failure counts as "no key", the safe state in which nothing paid is attempted.
 */
async function askImageGate(): Promise<ImageGate> {
  try {
    const gate = await sendMessage({ type: 'getImageGate' });
    return IMAGE_GATES.includes(gate) ? gate : 'no_key';
  } catch {
    return 'no_key';
  }
}

function openOptions(section: OptionsSection) {
  void sendMessage({ type: 'openOptions', section }).catch(() => undefined);
}

type Ui = Awaited<ReturnType<typeof createShadowRootUi<HTMLElement>>>;

/** Owns the card of this page: mounts it, updates it, and replaces it on a new run. */
function createCardController(ctx: ContentScriptContext) {
  let runId = 0;
  /** Item the current card belongs to, null when this page is not an item page. */
  let currentItemId: string | null = null;
  let ui: Ui | null = null;
  let container: HTMLElement | null = null;
  let keepAttached: MutationObserver | null = null;
  ctx.onInvalidated(() => stopKeepingAttached());

  function show(state: CardState) {
    if (!container) return;
    render(
      <ListingCard state={state} onRetry={() => void start()} onOpenOptions={openOptions} />,
      container,
    );
  }

  function stopKeepingAttached() {
    keepAttached?.disconnect();
    keepAttached = null;
  }

  /**
   * Vinted re-renders the item sidebar after load (seen ~0.3 s and ~2 s in), which drops the card
   * with it: move the same host, shadow tree and state included, next to the new anchor.
   */
  function keepCardAttached(host: HTMLElement) {
    stopKeepingAttached();
    keepAttached = new MutationObserver(() => {
      if (host.isConnected || ctx.isInvalid) return;
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
    const imageGate = askImageGate();
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

    const { verdict, checks } = await analyzeListing(listing, analysisDeps, {
      imageGate: await imageGate,
      // A superseded run must not spend API calls or downloads.
      isCancelled: () => id !== runId || ctx.isInvalid,
    });
    if (id !== runId) return;
    show({ status: 'done', listing, verdict, checks });
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
