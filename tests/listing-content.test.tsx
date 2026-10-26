import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import script from '../entrypoints/listing.content';

// Keep the real seller fetching but without the 1.5 s spacing (covered in api.test.ts).
vi.mock('../lib/vinted/api', async (importOriginal) => {
  const api = await importOriginal<typeof import('../lib/vinted/api')>();
  const queue = new api.RequestQueue(0);
  return { ...api, fetchSeller: (id: string) => api.fetchSeller(id, { queue }) };
});

// Integration test of the content script on a synthetic item page. Every id and name is made up.
type HappyWindow = import('happy-dom').Window;

const ITEM_URL = 'https://www.vinted.fr/items/9000001-robe-test';

const PRODUCT = {
  '@type': 'Product',
  name: 'Robe de soirée',
  description: 'Robe portée une fois.',
  image: 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa',
  brand: { name: 'Marque Test' },
  offers: { price: 12.5, priceCurrency: 'EUR' },
};

const PAGE = `
  <script type="application/ld+json">${JSON.stringify(PRODUCT)}</script>
  <main>
    <div class="details-list--main-info">
      <div class="details-list--pricing"><span data-testid="item-price">12,50 €</span></div>
      <div class="details-list--details"></div>
    </div>
    <div data-testid="item-attributes-status"><div>État</div><span itemprop="status">Très bon état</span></div>
    <a href="/member/7000001"><span data-testid="profile-username">vendeuse_test</span></a>
    <div data-testid="item-photo-1"><img data-testid="item-photo-1--img" src="https://images1.vinted.net/t/01_a/f800/main.webp?s=aa"></div>
  </main>`;

const SHEIN_EXACT = {
  platform: 'Shein',
  url: 'https://fr.shein.com/Robe-Test-p-1234567-cat-1727.html',
  exact: true,
  price: null,
};
const TEMU_SIMILAR = {
  platform: 'Temu',
  url: 'https://www.temu.com/robe-g-601099512345678.html',
  exact: false,
  price: null,
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function stubFetch() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      calls.push(String(input));
      if (String(input).includes('/api/v2/users/')) {
        return Promise.resolve(
          json({
            user: {
              id: 7000001,
              login: 'vendeuse_test',
              feedback_count: 80,
              feedback_reputation: 0.96,
              item_count: 1,
            },
          }),
        );
      }
      if (String(input).includes('/wardrobe/')) {
        return Promise.resolve(
          json({
            items: [
              {
                id: 2,
                title: 'Autre article très particulier',
                price: { amount: '9', currency_code: 'EUR' },
                status: 'Bon état',
                size: 'M',
                photos: [{ is_main: true, url: 'https://images1.vinted.net/t/02/f800/p.webp?s=2' }],
              },
            ],
            pagination: { total_entries: 1 },
          }),
        );
      }
      // The WXT CSS loader: nothing to load in tests.
      return Promise.resolve(new Response('', { status: 404 }));
    }),
  );
  return calls;
}

function hostCard(): Element | null {
  return document.querySelector('fripon-listing-card');
}

function shadowText(): string {
  return hostCard()?.shadowRoot?.textContent ?? '';
}

async function until(predicate: () => boolean, timeoutMs = 8_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the card');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** What the background answers to `getImageGate`; an Error makes the message fail. */
let imageGate: string | Error;

type SentMessage = {
  type: string;
  url?: string;
  photoUrl?: string;
  cacheOnly?: boolean;
  section?: string;
};

/**
 * What the background answers to `searchImage`; a promise lets a test hold the answer back. By
 * default it answers as the real one would for the gate: no key, quota, the cache only, or nothing found.
 */
let searchAnswer: (message: SentMessage) => Promise<unknown>;

const PHOTO_URL = 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa';

/** The searches that can spend: not the look in the cache that "Au clic" mode makes by itself. */
const paidSearches = () => sentMessages('searchImage').filter((message) => !message.cacheOnly);

function sentMessages(type: string): SentMessage[] {
  return vi
    .mocked(browser.runtime.sendMessage)
    .mock.calls.map(([message]) => message as unknown as SentMessage)
    .filter((message) => message.type === type);
}

async function expandChecks() {
  const toggle = hostCard()?.shadowRoot?.querySelector('.fripon__toggle') as HTMLButtonElement;
  toggle.click();
  await until(() => shadowText().includes('Chercher moi-même sur Google Lens'));
}

function actionButton(): HTMLButtonElement | null {
  return hostCard()?.shadowRoot?.querySelector('.fripon__action') ?? null;
}

/** Holds the answer of the real search until the test releases it; the look in the cache answers at once. */
function holdSearch() {
  let release: (value: unknown) => void = () => undefined;
  searchAnswer = (message) =>
    message.cacheOnly
      ? Promise.resolve({ status: 'not_cached' })
      : new Promise((resolve) => {
          release = resolve;
        });
  return (value: unknown) => release(value);
}

let ctx: ContentScriptContext;

beforeEach(() => {
  fakeBrowser.reset();
  (window as unknown as HappyWindow).happyDOM.setURL(ITEM_URL);
  document.head.innerHTML = '';
  document.body.innerHTML = PAGE;
  imageGate = 'no_key';
  searchAnswer = (message) =>
    Promise.resolve(
      message.cacheOnly
        ? { status: 'not_cached' }
        : imageGate === 'quota'
          ? { status: 'quota' }
          : imageGate === 'ready' || imageGate === 'manual'
            ? { status: 'ok', matches: [] }
            : { status: 'no_key' },
    );
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: SentMessage) => {
    if (message.type === 'getImageGate') {
      return imageGate instanceof Error ? Promise.reject(imageGate) : Promise.resolve(imageGate);
    }
    if (message.type === 'openOptions') return Promise.resolve(undefined);
    if (message.type === 'searchImage') return searchAnswer(message);
    return Promise.resolve({
      ok: true,
      hash: message.url?.includes('/02/') ? 'ffffffffffffffff' : '0000000000000000',
      catalogScore: 0.1,
    });
  }) as never);
  ctx = new ContentScriptContext('listing', { matches: [] });
});

afterEach(() => {
  ctx.notifyInvalidated();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('listing content script', () => {
  it('mounts the card after the price block, then shows the verdict', async () => {
    const calls = stubFetch();
    await script.main(ctx);

    await until(() => hostCard() !== null);
    expect(document.querySelector('.details-list--pricing')?.nextElementSibling).toBe(hostCard());
    await until(() => shadowText().includes('Voir les 5 vérifications'));

    expect(shadowText()).toContain('Rien de suspect');
    expect(calls.filter((url) => url.startsWith('/api/'))).toEqual([
      '/api/v2/users/7000001',
      '/api/v2/wardrobe/7000001/items?page=1&per_page=96',
    ]);
    expect(sentMessages('analyzeImage')).toHaveLength(2);
    // The gate is asked once per run, and only that: no key ever travels to the page.
    expect(sentMessages('getImageGate')).toEqual([{ type: 'getImageGate' }]);
  }, 15_000);

  describe('when Vinted re-renders the item sidebar', () => {
    const rerenderPriceBlock = () => {
      document.querySelector('.details-list--main-info')?.remove();
      const fresh = document.createElement('div');
      fresh.className = 'details-list--main-info';
      fresh.innerHTML = '<div class="details-list--pricing"><span>12,50 €</span></div>';
      document.querySelector('main')?.prepend(fresh);
      return fresh.querySelector('.details-list--pricing');
    };

    it('puts the same card back after the new price block, without a new analysis', async () => {
      const calls = stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await expandChecks();
      const card = hostCard();
      const apiCalls = calls.filter((url) => url.startsWith('/api/')).length;

      const pricing = rerenderPriceBlock();

      await until(() => pricing?.nextElementSibling === card);
      expect(document.querySelectorAll('fripon-listing-card')).toHaveLength(1);
      // Same shadow tree: the verdict and the expanded checks survive.
      expect(shadowText()).toContain('Chercher moi-même sur Google Lens');
      expect(calls.filter((url) => url.startsWith('/api/'))).toHaveLength(apiCalls);
      expect(sentMessages('getImageGate')).toHaveLength(1);
    }, 15_000);

    it('waits for the price block to come back when it is removed alone', async () => {
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      const card = hostCard();

      document.querySelector('.details-list--main-info')?.remove();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(card?.isConnected).toBe(false);
      const pricing = rerenderPriceBlock();

      await until(() => pricing?.nextElementSibling === card);
    }, 15_000);

    it('does not bring the card back once the script is invalidated', async () => {
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));

      ctx.notifyInvalidated();
      expect(rerenderPriceBlock()?.isConnected).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(hostCard()).toBeNull();
    }, 15_000);
  });

  describe('image search gate', () => {
    it('offers the guide without a key, and the button opens it', async () => {
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await expandChecks();

      expect(actionButton()?.textContent).toBe('Activer en 2 minutes');
      actionButton()?.click();
      expect(sentMessages('openOptions')).toEqual([{ type: 'openOptions', section: 'guide' }]);
      // The page asks whatever the gate: the background has the last word on keys and credits.
      expect(sentMessages('searchImage')).toEqual([{ type: 'searchImage', photoUrl: PHOTO_URL }]);
    }, 15_000);

    it('shows the cap reached with a link to the settings on quota', async () => {
      imageGate = 'quota';
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await expandChecks();

      expect(shadowText()).toContain('Plafond atteint');
      expect(actionButton()?.textContent).toBe('Voir mes réglages');
      actionButton()?.click();
      expect(sentMessages('openOptions')).toEqual([{ type: 'openOptions', section: 'credits' }]);
    }, 15_000);

    it('searches the main photo when the gate is open, and says nothing was found', async () => {
      imageGate = 'ready';
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await expandChecks();

      await until(() => shadowText().includes('Introuvable'));
      expect(sentMessages('searchImage')).toEqual([{ type: 'searchImage', photoUrl: PHOTO_URL }]);
      expect(shadowText()).toContain('Rien de suspect');
      expect(shadowText()).not.toContain('sans recherche d');
      expect(actionButton()).toBeNull();
    }, 15_000);

    it('shows the exact match with its platform, a link and the verdict', async () => {
      imageGate = 'ready';
      searchAnswer = () => Promise.resolve({ status: 'ok', matches: [SHEIN_EXACT, TEMU_SIMILAR] });
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Article Shein revendu'));
      await expandChecks();

      expect(shadowText()).toContain('Trouvée sur Shein');
      const links = [...(hostCard()?.shadowRoot?.querySelectorAll('a') ?? [])];
      expect(links.map((a) => a.textContent)).toEqual([
        'Voir sur Shein',
        'Photo proche sur Temu',
        'Chercher moi-même sur Google Lens',
      ]);
      expect(links[0]?.getAttribute('href')).toBe(SHEIN_EXACT.url);
    }, 15_000);

    it('shows why the search was impossible when Google refuses the key', async () => {
      imageGate = 'ready';
      searchAnswer = () => Promise.resolve({ status: 'error', reason: 'billing' });
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await expandChecks();
      await until(() => shadowText().includes('Recherche impossible'));

      expect(shadowText()).toContain('Google refuse ta clé Vision');
      expect(actionButton()?.textContent).toBe('Vérifier ma clé');
      actionButton()?.click();
      expect(sentMessages('openOptions')).toEqual([{ type: 'openOptions', section: 'keys' }]);
    }, 15_000);

    it('still shows the free checks when the search cannot reach the background', async () => {
      imageGate = 'ready';
      searchAnswer = () => Promise.reject(new Error('Extension context invalidated'));
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await expandChecks();
      await until(() => shadowText().includes('Recherche impossible'));
      expect(shadowText()).toContain('Google ne répond pas');
    }, 15_000);

    it('offers to search again after a failure that may pass, and searches again on click', async () => {
      imageGate = 'ready';
      searchAnswer = () => Promise.resolve({ status: 'error', reason: 'network' });
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      // Collapsed card: the retry button is under the verdict.
      await until(() => actionButton()?.textContent === 'Réessayer la recherche');

      searchAnswer = () => Promise.resolve({ status: 'ok', matches: [SHEIN_EXACT] });
      actionButton()?.click();
      await until(() => shadowText().includes('Article Shein revendu'));
      expect(paidSearches()).toHaveLength(2);
      expect(actionButton()).toBeNull();
    }, 15_000);

    it('shows the card from the free checks before Google answers', async () => {
      imageGate = 'ready';
      const answer = holdSearch();
      const calls = stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));

      // The verdict is there, the search is still out.
      expect(shadowText()).toContain('Rien de suspect');
      expect(calls.filter((url) => url.startsWith('/api/'))).toHaveLength(2);
      await expandChecks();
      expect(shadowText()).toContain('Recherche en cours…');
      expect(paidSearches()).toHaveLength(1);

      answer({ status: 'ok', matches: [SHEIN_EXACT] });
      await until(() => shadowText().includes('Trouvée sur Shein'));
      expect(shadowText()).not.toContain('Recherche en cours…');
      expect(shadowText()).toContain('Article Shein revendu');
      // The free checks were not run again.
      expect(calls.filter((url) => url.startsWith('/api/'))).toHaveLength(2);
      expect(paidSearches()).toHaveLength(1);
    }, 15_000);

    it('shows the cached result of a photo already searched, with no key at all', async () => {
      imageGate = 'no_key';
      searchAnswer = () => Promise.resolve({ status: 'ok', matches: [SHEIN_EXACT] });
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Article Shein revendu'));
      await expandChecks();
      expect(shadowText()).toContain('Trouvée sur Shein');
    }, 15_000);

    it('runs the free checks and waits for a click in manual mode', async () => {
      imageGate = 'manual';
      const calls = stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await expandChecks();

      expect(calls.filter((url) => url.startsWith('/api/'))).toHaveLength(2);
      // By itself it only looks in the cache, which costs nothing.
      expect(sentMessages('searchImage')).toEqual([
        { type: 'searchImage', photoUrl: PHOTO_URL, cacheOnly: true },
      ]);
      expect(actionButton()?.textContent).toBe("Lancer la recherche d'image");
      expect(shadowText()).toContain('Au clic');
    }, 15_000);

    it('puts the search button on the collapsed card in manual mode', async () => {
      imageGate = 'manual';
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      expect(actionButton()?.textContent).toBe("Lancer la recherche d'image");
      expect(hostCard()?.shadowRoot?.querySelector('.fripon > .fripon__actions')).not.toBeNull();
    }, 15_000);

    it.each([
      ['an error', () => Promise.resolve({ status: 'error', reason: 'network' })],
      ['a miss', () => Promise.resolve({ status: 'not_cached' })],
      ['a lost message', () => Promise.reject(new Error('Extension context invalidated'))],
      ['no answer at all', () => Promise.resolve(undefined)],
    ])(
      'leaves the "Au clic" row alone when the look in the cache ends in %s',
      async (_name, answer) => {
        imageGate = 'manual';
        searchAnswer = (message) =>
          message.cacheOnly ? answer() : Promise.resolve({ status: 'ok', matches: [SHEIN_EXACT] });
        stubFetch();
        await script.main(ctx);
        await until(() => shadowText().includes('Voir les 5 vérifications'));
        await until(() => sentMessages('searchImage').length === 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await expandChecks();

        expect(shadowText()).toContain('Au clic');
        expect(shadowText()).not.toContain('Recherche impossible');
        expect(actionButton()?.textContent).toBe("Lancer la recherche d'image");
        // The button still works.
        actionButton()?.click();
        await until(() => shadowText().includes('Trouvée sur Shein'));
      },
      15_000,
    );

    it('shows the cached result in manual mode without a click and without spending', async () => {
      imageGate = 'manual';
      searchAnswer = (message) =>
        Promise.resolve(
          message.cacheOnly
            ? { status: 'ok', matches: [SHEIN_EXACT] }
            : { status: 'error', reason: 'network' },
        );
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Article Shein revendu'));
      await expandChecks();

      expect(shadowText()).toContain('Trouvée sur Shein');
      expect(actionButton()).toBeNull();
      expect(paidSearches()).toEqual([]);
    }, 15_000);

    it.each([new Error('background asleep'), 'whatever'])(
      'falls back to "no key" when the gate is unavailable or unknown (%s)',
      async (answer) => {
        imageGate = answer;
        stubFetch();
        await script.main(ctx);
        await until(() => shadowText().includes('Voir les 5 vérifications'));
        await expandChecks();

        expect(actionButton()?.textContent).toBe('Activer en 2 minutes');
      },
      15_000,
    );
  });

  describe('image search on click (manual mode)', () => {
    const apiCalls = (calls: string[]) => calls.filter((url) => url.startsWith('/api/'));

    async function openManualCard() {
      imageGate = 'manual';
      const calls = stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await expandChecks();
      return calls;
    }

    it('searches on click, shows the row loading, then the result and a new verdict', async () => {
      const answer = holdSearch();
      const calls = await openManualCard();
      expect(shadowText()).toContain('Rien de suspect');
      const photoAnalyses = sentMessages('analyzeImage').length;
      const requests = apiCalls(calls).length;

      actionButton()?.click();
      await until(() => shadowText().includes('Recherche en cours…'));
      expect(shadowText()).toContain('En cours');
      expect(actionButton()).toBeNull();
      expect(paidSearches()).toHaveLength(1);
      // The verdict is not touched until the answer comes.
      expect(shadowText()).toContain('Rien de suspect');

      answer({ status: 'ok', matches: [SHEIN_EXACT] });
      await until(() => shadowText().includes('Trouvée sur Shein'));

      expect(shadowText()).toContain('Article Shein revendu');
      expect(shadowText()).not.toContain('Recherche en cours…');
      expect(
        hostCard()?.shadowRoot?.querySelector('a[href^="https://fr.shein.com"]'),
      ).not.toBeNull();
      // No new free check: neither a Vinted request nor a photo download.
      expect(apiCalls(calls)).toHaveLength(requests);
      expect(sentMessages('analyzeImage')).toHaveLength(photoAnalyses);
      expect(sentMessages('getImageGate')).toHaveLength(1);
      expect(paidSearches()).toHaveLength(1);
      // The checks stayed expanded through the updates.
      expect(shadowText()).toContain('Chercher moi-même sur Google Lens');
    }, 15_000);

    it('lets a click search even while the look in the cache has not answered', async () => {
      imageGate = 'manual';
      searchAnswer = (message) =>
        message.cacheOnly
          ? new Promise(() => undefined)
          : Promise.resolve({ status: 'ok', matches: [SHEIN_EXACT] });
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      expect(sentMessages('searchImage')).toHaveLength(1);

      actionButton()?.click();
      await until(() => shadowText().includes('Article Shein revendu'));
      expect(paidSearches()).toHaveLength(1);
    }, 15_000);

    it('ignores a late cache answer once the click has started its search', async () => {
      imageGate = 'manual';
      let cacheAnswer: (value: unknown) => void = () => undefined;
      const answer = holdSearch();
      const real = searchAnswer;
      searchAnswer = (message) =>
        message.cacheOnly
          ? new Promise((resolve) => {
              cacheAnswer = resolve;
            })
          : real(message);
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));

      actionButton()?.click();
      await until(() => shadowText().includes('Recherche en cours…') || actionButton() === null);
      cacheAnswer({ status: 'ok', matches: [TEMU_SIMILAR] });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The late cache answer did not interrupt the search that is running.
      expect(shadowText()).not.toContain('À vérifier');
      expect(shadowText()).toContain('Rien de suspect');
      answer({ status: 'ok', matches: [SHEIN_EXACT] });
      await until(() => shadowText().includes('Article Shein revendu'));
    }, 15_000);

    it('searches once even if the button is clicked twice', async () => {
      const answer = holdSearch();
      await openManualCard();
      const button = actionButton();
      button?.click();
      button?.click();
      await until(() => shadowText().includes('Recherche en cours…'));
      answer({ status: 'ok', matches: [] });
      await until(() => shadowText().includes('Introuvable'));
      expect(paidSearches()).toHaveLength(1);
    }, 15_000);

    it('shows a failed search on the row, with the verdict still saying it did not run', async () => {
      searchAnswer = () => Promise.resolve({ status: 'error', reason: 'network' });
      await openManualCard();
      actionButton()?.click();
      await until(() => shadowText().includes('Recherche impossible'));
      expect(shadowText()).toContain('Google ne répond pas, réessaie plus tard.');
      expect(shadowText()).toContain('sans recherche d');
    }, 15_000);

    it('shows the green verdict when nothing is found', async () => {
      await openManualCard();
      expect(shadowText()).toContain("Rien de suspect (sans recherche d'image)");
      actionButton()?.click();
      await until(() => shadowText().includes('Introuvable'));
      expect(shadowText()).not.toContain('sans recherche d');
    }, 15_000);

    it('keeps the answer when Vinted re-renders the sidebar during the search', async () => {
      const answer = holdSearch();
      await openManualCard();
      const card = hostCard();
      actionButton()?.click();
      await until(() => shadowText().includes('Recherche en cours…'));

      document.querySelector('.details-list--main-info')?.remove();
      const fresh = document.createElement('div');
      fresh.className = 'details-list--main-info';
      fresh.innerHTML = '<div class="details-list--pricing"><span>12,50 €</span></div>';
      document.querySelector('main')?.prepend(fresh);
      await until(() => fresh.querySelector('.details-list--pricing')?.nextElementSibling === card);

      answer({ status: 'ok', matches: [SHEIN_EXACT] });
      await until(() => shadowText().includes('Trouvée sur Shein'));
      expect(hostCard()).toBe(card);
      expect(document.querySelectorAll('fripon-listing-card')).toHaveLength(1);
    }, 15_000);

    it('drops the answer of a search that a newer run replaced', async () => {
      const answer = holdSearch();
      await openManualCard();
      actionButton()?.click();
      await until(() => shadowText().includes('Recherche en cours…'));

      // A bfcache restore starts the whole run again, with a fresh card.
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      answer({ status: 'ok', matches: [SHEIN_EXACT] });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The new card is collapsed: the verdict is where a stale answer would show.
      expect(shadowText()).not.toContain('Article Shein revendu');
      expect(shadowText()).toContain("Rien de suspect (sans recherche d'image)");
      expect(document.querySelectorAll('fripon-listing-card')).toHaveLength(1);
    }, 15_000);
  });

  it('does nothing but warn when there is no anchor', async () => {
    stubFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    document.body.innerHTML = '<p>empty</p>';
    vi.useFakeTimers();
    await script.main(ctx);
    await vi.advanceTimersByTimeAsync(10_500);
    vi.useRealTimers();

    expect(hostCard()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[Fripon]'));
  });

  it('runs again on a bfcache restore without duplicating the card', async () => {
    const calls = stubFetch();
    await script.main(ctx);
    await until(() => shadowText().includes('Voir les 5 vérifications'));

    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await until(() => shadowText().includes('Voir les 5 vérifications'));

    expect(document.querySelectorAll('fripon-listing-card')).toHaveLength(1);
    // The seller comes from the 24 h cache the second time.
    expect(calls.filter((url) => url.startsWith('/api/'))).toHaveLength(2);
  }, 15_000);

  it('ignores a pageshow that is not a bfcache restore', async () => {
    stubFetch();
    await script.main(ctx);
    await until(() => shadowText().includes('Voir les 5 vérifications'));
    const host = hostCard();

    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hostCard()).toBe(host);
  }, 15_000);

  it('shows the error state when the listing cannot be read', async () => {
    stubFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    document.querySelector('[data-testid="profile-username"]')?.closest('a')?.remove();
    vi.useFakeTimers();
    await script.main(ctx);
    await vi.advanceTimersByTimeAsync(10_500);
    await vi.advanceTimersByTimeAsync(10_500);
    vi.useRealTimers();

    expect(shadowText()).toContain("Fripon n'a pas pu analyser cette annonce.");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[Fripon]'));
  });

  it('keeps a single card, and spends no request, when a run starts while another is mounting', async () => {
    const calls = stubFetch();
    await script.main(ctx);
    // The first run is still waiting for the shadow root UI: restart it right away.
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));

    await until(() => shadowText().includes('Voir les 5 vérifications'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelectorAll('fripon-listing-card')).toHaveLength(1);
    expect(calls.filter((url) => url.startsWith('/api/'))).toHaveLength(2);
    expect(sentMessages('analyzeImage')).toHaveLength(2);
    // Only the run that finished asks for the search: the superseded ones ask for nothing.
    expect(sentMessages('searchImage')).toHaveLength(1);
  }, 15_000);

  it('sends no search for a script that was invalidated during the analysis', async () => {
    imageGate = 'ready';
    const calls = stubFetch();
    const fetchMock = vi.mocked(fetch);
    const inner = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(((input: string, init?: RequestInit) => {
      if (String(input).includes('/wardrobe/')) ctx.notifyInvalidated();
      return inner?.(input, init);
    }) as never);
    await script.main(ctx);
    await until(() => calls.some((url) => url.includes('/wardrobe/')));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(sentMessages('searchImage')).toEqual([]);
    expect(shadowText()).not.toContain('Voir les 5 vérifications');
  }, 15_000);

  describe('navigation without a page load', () => {
    // WXT's own watcher polls once a second: capture the handler the script registers and call
    // it directly, which is exactly what the watcher's event would do.
    type LocationHandler = (event: { newUrl: URL }) => void;
    let handlers: LocationHandler[] = [];

    beforeEach(() => {
      handlers = [];
      const original = window.addEventListener.bind(window);
      vi.spyOn(window, 'addEventListener').mockImplementation(((
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type.endsWith('wxt:locationchange'))
          handlers.push(handler as unknown as LocationHandler);
        original(type, handler, options);
      }) as typeof window.addEventListener);
    });

    function navigate(to: string) {
      (window as unknown as HappyWindow).happyDOM.setURL(to);
      for (const handler of handlers) handler({ newUrl: new URL(to) });
    }

    it('analyses the new item when the item id changes', async () => {
      const calls = stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      const first = hostCard();

      navigate('https://www.vinted.fr/items/9000002-autre-robe');
      await until(() => hostCard() !== null && hostCard() !== first);
      await until(() => shadowText().includes('Voir les 5 vérifications'));

      expect(document.querySelectorAll('fripon-listing-card')).toHaveLength(1);
      // The seller comes from the cache, only the photos are analysed again.
      expect(calls.filter((url) => url.startsWith('/api/'))).toHaveLength(2);
    }, 15_000);

    it('keeps the card when only the query string changes', async () => {
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      const first = hostCard();

      navigate('https://www.vinted.fr/items/9000001-robe-test?referrer=catalog');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(hostCard()).toBe(first);
    }, 15_000);

    it('removes the card when leaving the item page, and stops any run in progress', async () => {
      const calls = stubFetch();
      await script.main(ctx);
      // Leave while the first run is still starting.
      navigate('https://www.vinted.fr/catalog?search_text=robe');
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(hostCard()).toBeNull();
      expect(calls.filter((url) => url.startsWith('/api/'))).toHaveLength(0);
    }, 15_000);

    it('removes a finished card when leaving, and brings it back on a new item', async () => {
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));

      navigate('https://www.vinted.fr/catalog');
      expect(hostCard()).toBeNull();

      navigate('https://www.vinted.fr/items/9000003-encore');
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      expect(document.querySelectorAll('fripon-listing-card')).toHaveLength(1);
    }, 15_000);
  });
});
