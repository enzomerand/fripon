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

/** What the background answers to `getGates` for the image search; an Error makes the message fail. */
let imageGate: string | Error;
/** ... and for the AI review. */
let aiGate: string;

type SentMessage = {
  type: string;
  url?: string;
  photoUrl?: string;
  cacheOnly?: boolean;
  retry?: boolean;
  section?: string;
  verdict?: { level: string; title: string } | null;
  input?: {
    photoUrl: string;
    title: string;
    description: string;
    price: string;
    signals: string[];
    fingerprint: string[];
  };
};

/**
 * What the background answers to `searchImage`; a promise lets a test hold the answer back. By
 * default it answers as the real one would for the gate: no key, quota, the cache only, or nothing found.
 */
let searchAnswer: (message: SentMessage) => Promise<unknown>;

/**
 * What the background answers to `aiReview`; a promise lets a test hold the answer back. By
 * default it answers as the real one would for the gate: no key, quota, the cache only, or a review.
 */
let aiAnswer: (message: SentMessage) => Promise<unknown>;

const REVIEW = { catalogPhoto: false, summary: 'Résumé de test.' };

const PHOTO_URL = 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa';

/** The searches that can spend: not the look in the cache that "Au clic" mode makes by itself. */
const paidSearches = () => sentMessages('searchImage').filter((message) => !message.cacheOnly);
/** The reviews that can spend: not the look in the cache that "Au clic" mode makes by itself. */
const paidReviews = () => sentMessages('aiReview').filter((message) => !message.cacheOnly);

function sentMessages(type: string): SentMessage[] {
  return vi
    .mocked(browser.runtime.sendMessage)
    .mock.calls.map(([message]) => message as unknown as SentMessage)
    .filter((message) => message.type === type);
}

/** The verdicts the card put on the toolbar badge, in order; null is a clearing. */
const badgeVerdicts = () => sentMessages('setVerdictBadge').map((message) => message.verdict);

async function expandChecks() {
  const toggle = hostCard()?.shadowRoot?.querySelector('.fripon__toggle') as HTMLButtonElement;
  toggle.click();
  await until(() => shadowText().includes('Chercher moi-même sur Google Lens'));
}

function actionButton(): HTMLButtonElement | null {
  return hostCard()?.shadowRoot?.querySelector('.fripon__action') ?? null;
}

/** Holds the answer of the real review until the test releases it; the look in the cache answers at once. */
function holdReview() {
  let release: (value: unknown) => void = () => undefined;
  aiAnswer = (message) =>
    message.cacheOnly
      ? Promise.resolve({ status: 'not_cached' })
      : new Promise((resolve) => {
          release = resolve;
        });
  return (value: unknown) => release(value);
}

/** The text of the AI block of the expanded card, '' when the card has none. */
function aiText(): string {
  return hostCard()?.shadowRoot?.querySelector('.fripon__ai')?.textContent ?? '';
}

/** The order in which the paid requests were sent. */
function paidOrder(): string[] {
  return vi
    .mocked(browser.runtime.sendMessage)
    .mock.calls.map(([message]) => message as unknown as SentMessage)
    .filter((message) => ['searchImage', 'aiReview'].includes(message.type))
    .map((message) => `${message.type}${message.cacheOnly ? ':cache' : ''}`);
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
  aiGate = 'no_key';
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
  aiAnswer = (message) =>
    Promise.resolve(
      message.cacheOnly
        ? { status: 'not_cached' }
        : aiGate === 'quota'
          ? { status: 'quota' }
          : aiGate === 'ready' || aiGate === 'manual'
            ? { status: 'ok', review: REVIEW }
            : { status: 'no_key' },
    );
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: SentMessage) => {
    if (message.type === 'getGates') {
      return imageGate instanceof Error
        ? Promise.reject(imageGate)
        : Promise.resolve({ image: imageGate, ai: aiGate });
    }
    if (message.type === 'openOptions') return Promise.resolve(undefined);
    if (message.type === 'setVerdictBadge') return Promise.resolve(undefined);
    if (message.type === 'searchImage') return searchAnswer(message);
    if (message.type === 'aiReview') return aiAnswer(message);
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
    // The gates are asked once per run, and only that: no key ever travels to the page.
    expect(sentMessages('getGates')).toEqual([{ type: 'getGates' }]);
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
      expect(sentMessages('getGates')).toHaveLength(1);
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
      expect(sentMessages('getGates')).toHaveLength(1);
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

  describe('AI review', () => {
    async function openCard() {
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await expandChecks();
    }

    it('reviews the listing after the image search, with its result among the signals', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      searchAnswer = () => Promise.resolve({ status: 'ok', matches: [SHEIN_EXACT, TEMU_SIMILAR] });
      await openCard();
      await until(() => aiText().includes('Résumé de test.'));

      expect(paidOrder()).toEqual(['searchImage', 'aiReview']);
      const [review] = sentMessages('aiReview');
      expect(review?.cacheOnly).toBeUndefined();
      expect(review?.input).toMatchObject({
        photoUrl: PHOTO_URL,
        title: 'Robe de soirée',
        description: 'Robe portée une fois.',
      });
      expect(review?.input?.price.replace(/\s/g, ' ')).toBe('12,50 €');
      expect(review?.input?.signals[0]).toBe(
        "Recherche d'image : la même photo est en vente sur Shein.",
      );
      expect(review?.input?.signals.join('\n')).toContain('Vendeur (');
      expect(review?.input?.fingerprint[0]).toBe(
        "Recherche d'image : la même photo est en vente sur Shein.",
      );
      // The block: a title, the summary, the reminder that it can be wrong.
      expect(aiText()).toContain("L'avis de l'IA");
      expect(aiText()).toContain('Résumé de test.');
      expect(aiText()).toContain('Résumé par Gemini, il peut se tromper.');
    }, 15_000);

    it('puts the summary in the expanded card only', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await until(() => sentMessages('aiReview').length === 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(shadowText()).not.toContain('Résumé de test.');
      await expandChecks();
      expect(aiText()).toContain('Résumé de test.');
    }, 15_000);

    it('waits for the image search before asking the AI', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      const release = holdSearch();
      await openCard();
      await until(() => sentMessages('searchImage').length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sentMessages('aiReview')).toEqual([]);

      release({ status: 'ok', matches: [] });
      await until(() => aiText().includes('Résumé de test.'));
      expect(paidOrder()).toEqual(['searchImage', 'aiReview']);
      expect(sentMessages('aiReview')[0]?.input?.signals[0]).toBe(
        "Recherche d'image : aucune trace de la photo sur Shein, Temu, AliExpress…",
      );
    }, 15_000);

    it('says the AI is reading while the review runs', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      const release = holdReview();
      await openCard();
      await until(() => aiText().includes("L'IA lit l'annonce…"));
      expect(aiText()).not.toContain('Résumé par Gemini');

      release({ status: 'ok', review: REVIEW });
      await until(() => aiText().includes('Résumé de test.'));
      expect(aiText()).not.toContain("L'IA lit l'annonce…");
    }, 15_000);

    it('reviews even when the image search is not available, and says so to the AI', async () => {
      imageGate = 'no_key';
      aiGate = 'ready';
      await openCard();
      await until(() => aiText().includes('Résumé de test.'));
      expect(sentMessages('aiReview')[0]?.input?.signals[0]).toBe("Recherche d'image : non faite.");
    }, 15_000);

    it('confirms a catalogue photo on the Photos row and redoes the verdict', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      searchAnswer = () => Promise.resolve({ status: 'ok', matches: [SHEIN_EXACT] });
      aiAnswer = () =>
        Promise.resolve({
          status: 'ok',
          review: { catalogPhoto: true, summary: 'Photo de studio, vue sur Shein.' },
        });
      await openCard();
      await until(() => shadowText().includes('Photo catalogue'));

      expect(shadowText()).toContain("L'IA confirme une photo de catalogue ou de studio.");
      // An exact match and a strong signal: the verdict rules say dropshipping, not the AI.
      expect(shadowText()).toContain('Dropshipping probable');
      expect(aiText()).toContain('Photo de studio, vue sur Shein.');
    }, 15_000);

    it('only sees a catalogue photo, and leaves the green verdict, when the image search found nothing', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      aiAnswer = () =>
        Promise.resolve({
          status: 'ok',
          review: { catalogPhoto: true, summary: 'Photo de studio.' },
        });
      await openCard();
      await until(() => shadowText().includes("L'IA voit une photo de catalogue ou de studio."));

      expect(shadowText()).toContain('Photo type catalogue');
      expect(shadowText()).not.toContain("L'IA confirme");
      expect(shadowText()).toContain('Rien de suspect');
      expect(shadowText()).not.toContain('À vérifier');
    }, 15_000);

    it('leaves the Photos row alone when the AI sees no catalogue photo', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      await openCard();
      await until(() => aiText().includes('Résumé de test.'));
      expect(shadowText()).not.toContain('Photo catalogue');
      expect(shadowText()).toContain('Rien de suspect');
    }, 15_000);

    it('says nothing of the AI without a Gemini key', async () => {
      imageGate = 'ready';
      aiGate = 'no_key';
      await openCard();
      await until(() => sentMessages('aiReview').length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(hostCard()?.shadowRoot?.querySelector('.fripon__ai')).toBeNull();
      expect(shadowText()).not.toContain("L'avis de l'IA");
      expect(shadowText()).not.toContain("L'IA lit l'annonce…");
    }, 15_000);

    it('shows a review that is still in the cache even without a key', async () => {
      aiGate = 'no_key';
      aiAnswer = () => Promise.resolve({ status: 'ok', review: REVIEW });
      await openCard();
      await until(() => aiText().includes('Résumé de test.'));
    }, 15_000);

    it.each([
      [{ status: 'error', reason: 'network' }, "L'IA ne répond pas pour l'instant."],
      [{ status: 'error', reason: 'photo' }, "L'IA n'a pas pu lire la photo de l'annonce."],
      [{ status: 'error', reason: 'invalid_answer' }, "L'IA a donné une réponse inutilisable."],
      [
        { status: 'error', reason: 'quota' },
        'Google a atteint la limite de ta clé Gemini, réessaie plus tard.',
      ],
      [{ status: 'quota' }, "Le plafond d'avis de l'IA est atteint pour aujourd'hui."],
    ])(
      'shows a short neutral line when the review ends in %j',
      async (answer, line) => {
        imageGate = 'ready';
        aiGate = 'ready';
        aiAnswer = () => Promise.resolve(answer);
        await openCard();
        await until(() => aiText().includes(line));
        expect(aiText()).not.toContain('Résumé par Gemini');
        // The verdict does not move for a failed review.
        expect(shadowText()).toContain('Rien de suspect');
      },
      15_000,
    );

    it('shows the failure when the background does not answer at all', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      aiAnswer = () => Promise.reject(new Error('Extension context invalidated'));
      await openCard();
      await until(() => aiText().includes("L'IA ne répond pas pour l'instant."));
    }, 15_000);

    it('sends the user to the keys when Google refuses the Gemini key', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      aiAnswer = () => Promise.resolve({ status: 'error', reason: 'billing' });
      await openCard();
      await until(() => aiText().includes('Google refuse ta clé Gemini'));

      const button = hostCard()?.shadowRoot?.querySelector<HTMLButtonElement>(
        '.fripon__ai .fripon__action',
      );
      expect(button?.textContent).toBe('Vérifier ma clé');
      button?.click();
      expect(sentMessages('openOptions')).toContainEqual({ type: 'openOptions', section: 'keys' });
    }, 15_000);

    describe('when the image search is not final', () => {
      /** The first search fails (a retryable failure), the next ones answer with `then`. */
      function failThen(then: unknown) {
        let attempts = 0;
        searchAnswer = () =>
          Promise.resolve(++attempts === 1 ? { status: 'error', reason: 'network' } : then);
      }
      /** A review whose summary says which image line it was asked about. */
      const answerBySignal = () => {
        aiAnswer = (message) =>
          Promise.resolve({
            status: 'ok',
            review: { catalogPhoto: false, summary: `Résumé pour : ${message.input?.signals[0]}` },
          });
      };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

      it('waits for a retry of the search to succeed, then reviews with its result', async () => {
        imageGate = 'ready';
        aiGate = 'ready';
        failThen({ status: 'ok', matches: [SHEIN_EXACT] });
        answerBySignal();
        await openCard();
        await until(() => actionButton()?.textContent === 'Réessayer la recherche');
        await settle();
        // The row offers its retry: the review does not start, and the card says nothing of it.
        expect(sentMessages('aiReview')).toEqual([]);
        expect(hostCard()?.shadowRoot?.querySelector('.fripon__ai')).toBeNull();

        actionButton()?.click();
        await until(() => aiText().includes("Résumé pour : Recherche d'image : la même photo"));
        expect(paidSearches()).toHaveLength(2);
        expect(paidReviews()).toHaveLength(1);
        expect(paidReviews()[0]?.input?.signals[0]).toBe(
          "Recherche d'image : la même photo est en vente sur Shein.",
        );
        // The retry is the user's click, and the review it starts says so.
        expect(paidReviews()[0]?.retry).toBe(true);
      }, 15_000);

      it('keeps waiting while the retry fails the same way', async () => {
        imageGate = 'ready';
        aiGate = 'ready';
        searchAnswer = () => Promise.resolve({ status: 'error', reason: 'network' });
        await openCard();
        await until(() => actionButton()?.textContent === 'Réessayer la recherche');

        actionButton()?.click();
        await until(() => paidSearches().length === 2);
        await settle();
        expect(actionButton()?.textContent).toBe('Réessayer la recherche');
        expect(sentMessages('aiReview')).toEqual([]);
        expect(hostCard()?.shadowRoot?.querySelector('.fripon__ai')).toBeNull();
      }, 15_000);

      it.each([
        ['a cap reached', { status: 'quota' }],
        ['a photo that cannot be read', { status: 'error', reason: 'photo' }],
        ['a key Google refuses', { status: 'error', reason: 'billing' }],
        ['no key', { status: 'no_key' }],
      ])(
        'reviews as soon as the row is final: %s',
        async (_name, answer) => {
          imageGate = 'ready';
          aiGate = 'ready';
          searchAnswer = () => Promise.resolve(answer);
          await openCard();
          await until(() => aiText().includes('Résumé de test.'));
          expect(paidReviews()).toHaveLength(1);
          expect(paidReviews()[0]?.retry).toBeUndefined();
        },
        15_000,
      );

      it('does not review in manual mode while the click left a retry, then does once it succeeds', async () => {
        imageGate = 'manual';
        aiGate = 'manual';
        let attempts = 0;
        searchAnswer = (message) =>
          Promise.resolve(
            message.cacheOnly
              ? { status: 'not_cached' }
              : ++attempts === 1
                ? { status: 'error', reason: 'network' }
                : { status: 'ok', matches: [] },
          );
        answerBySignal();
        const real = aiAnswer;
        aiAnswer = (message) =>
          message.cacheOnly ? Promise.resolve({ status: 'not_cached' }) : real(message);
        await openCard();
        await until(() => sentMessages('aiReview').length === 1);

        actionButton()?.click();
        await until(() => actionButton()?.textContent === 'Réessayer la recherche');
        await settle();
        expect(paidReviews()).toEqual([]);
        // No stuck "L'IA lit l'annonce…": the block gave way to the row's single button.
        expect(aiText()).toBe('');

        actionButton()?.click();
        await until(() => aiText().includes("Résumé pour : Recherche d'image : aucune trace"));
        expect(paidReviews()).toHaveLength(1);
      }, 15_000);

      // Real gates cannot differ like this (the mode is shared); the test needs the two steps side
      // by side to prove a review is dropped and asked again when the image row changes under it.
      it('drops a review that the image row changed under, and asks again with the new row', async () => {
        imageGate = 'manual';
        aiGate = 'ready';
        let asked = 0;
        let releaseFirst: (value: unknown) => void = () => undefined;
        aiAnswer = (message) => {
          if (message.cacheOnly) return Promise.resolve({ status: 'not_cached' });
          if (++asked === 1) {
            return new Promise((resolve) => {
              releaseFirst = resolve;
            });
          }
          return Promise.resolve({
            status: 'ok',
            review: { catalogPhoto: false, summary: `Résumé pour : ${message.input?.signals[0]}` },
          });
        };
        await openCard();
        await until(() => aiText().includes("L'IA lit l'annonce…"));
        expect(actionButton()?.textContent).toBe("Lancer la recherche d'image");

        actionButton()?.click();
        await until(() => shadowText().includes('Introuvable'));
        // The first review is still on its way: the search did not wait for it.
        expect(sentMessages('aiReview').filter((m) => !m.cacheOnly)).toHaveLength(1);

        releaseFirst({ status: 'ok', review: { catalogPhoto: true, summary: 'Résumé périmé.' } });
        await until(() => aiText().includes("Résumé pour : Recherche d'image : aucune trace"));
        expect(paidReviews()).toHaveLength(2);
        // The stale answer was never shown, nor its catalogue photo applied.
        expect(aiText()).not.toContain('Résumé périmé.');
        expect(shadowText()).not.toContain('Photo type catalogue');
        // The second review is the user's click that changed the row, not the page's doing.
        expect(paidReviews()[0]?.retry).toBeUndefined();
        expect(paidReviews()[1]?.retry).toBe(true);
      }, 15_000);
    });

    it('keeps the answer when Vinted re-renders the sidebar during the review', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      const release = holdReview();
      await openCard();
      await until(() => aiText().includes("L'IA lit l'annonce…"));
      const card = hostCard();

      document.querySelector('.details-list--main-info')?.remove();
      const fresh = document.createElement('div');
      fresh.className = 'details-list--main-info';
      fresh.innerHTML = '<div class="details-list--pricing"><span>12,50 €</span></div>';
      document.querySelector('main')?.prepend(fresh);
      await until(() => fresh.querySelector('.details-list--pricing')?.nextElementSibling === card);

      release({ status: 'ok', review: REVIEW });
      await until(() => aiText().includes('Résumé de test.'));
      expect(hostCard()).toBe(card);
    }, 15_000);

    it('drops the answer of a review that a newer run replaced', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      const release = holdReview();
      await openCard();
      await until(() => aiText().includes("L'IA lit l'annonce…"));

      // A bfcache restore starts the whole run again, with a fresh card.
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      release({
        status: 'ok',
        review: { catalogPhoto: true, summary: 'Réponse périmée.' },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(shadowText()).not.toContain('Photo catalogue');
      expect(shadowText()).not.toContain('Réponse périmée.');
      expect(document.querySelectorAll('fripon-listing-card')).toHaveLength(1);
    }, 15_000);

    it('sends no review for a script that was invalidated during the image search', async () => {
      imageGate = 'ready';
      aiGate = 'ready';
      const release = holdSearch();
      await openCard();
      await until(() => sentMessages('searchImage').length === 1);

      ctx.notifyInvalidated();
      release({ status: 'ok', matches: [] });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sentMessages('aiReview')).toEqual([]);
    }, 15_000);

    describe('in manual mode', () => {
      const aiButton = () =>
        [
          ...(hostCard()?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.fripon__action') ?? []),
        ].find((button) => button.textContent === "Lancer l'avis IA");

      it('only looks in the cache by itself, for the image and for the AI', async () => {
        imageGate = 'manual';
        aiGate = 'manual';
        await openCard();
        await until(() => sentMessages('aiReview').length === 1);
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(paidOrder()).toEqual(['searchImage:cache', 'aiReview:cache']);
        // One button for both: the image search's, which starts the review along with it.
        expect(actionButton()?.textContent).toBe("Lancer la recherche d'image");
        expect(aiButton()).toBeUndefined();
        expect(hostCard()?.shadowRoot?.querySelector('.fripon__ai')).toBeNull();
      }, 15_000);

      it('runs the image search, then the review, on one click', async () => {
        imageGate = 'manual';
        aiGate = 'manual';
        searchAnswer = (message) =>
          Promise.resolve(
            message.cacheOnly ? { status: 'not_cached' } : { status: 'ok', matches: [SHEIN_EXACT] },
          );
        await openCard();
        await until(() => sentMessages('aiReview').length === 1);

        actionButton()?.click();
        await until(() => aiText().includes('Résumé de test.'));
        expect(paidOrder()).toEqual([
          'searchImage:cache',
          'aiReview:cache',
          'searchImage',
          'aiReview',
        ]);
        expect(sentMessages('aiReview')[1]?.input?.signals[0]).toBe(
          "Recherche d'image : la même photo est en vente sur Shein.",
        );
        expect(shadowText()).toContain('Trouvée sur Shein');
      }, 15_000);

      it('sends retry only with a click, never with what the page starts by itself', async () => {
        imageGate = 'manual';
        aiGate = 'manual';
        await openCard();
        await until(() => sentMessages('aiReview').length === 1);
        expect(sentMessages('searchImage')).toEqual([
          { type: 'searchImage', photoUrl: PHOTO_URL, cacheOnly: true },
        ]);
        expect(sentMessages('aiReview')[0]?.retry).toBeUndefined();

        actionButton()?.click();
        await until(() => sentMessages('aiReview').length === 2);
        expect(sentMessages('searchImage')[1]).toEqual({
          type: 'searchImage',
          photoUrl: PHOTO_URL,
          retry: true,
        });
        expect(sentMessages('aiReview')[1]?.retry).toBe(true);
        expect(sentMessages('aiReview')[1]?.cacheOnly).toBeUndefined();
      }, 15_000);

      it('shows no second button while the steps of a click run', async () => {
        imageGate = 'manual';
        aiGate = 'manual';
        const release = holdSearch();
        await openCard();
        actionButton()?.click();
        await until(() => shadowText().includes('Recherche en cours…'));
        expect(aiButton()).toBeUndefined();
        expect(aiText()).toContain("L'IA lit l'annonce…");

        release({ status: 'ok', matches: [] });
        await until(() => aiText().includes('Résumé de test.'));
      }, 15_000);

      it('starts the steps once even if the button is clicked twice', async () => {
        imageGate = 'manual';
        aiGate = 'manual';
        const release = holdSearch();
        await openCard();
        const button = actionButton();
        button?.click();
        button?.click();
        await until(() => shadowText().includes('Recherche en cours…'));
        release({ status: 'ok', matches: [] });
        await until(() => aiText().includes('Résumé de test.'));
        expect(paidSearches()).toHaveLength(1);
        expect(paidReviews()).toHaveLength(1);
      }, 15_000);

      it('offers "Lancer l\'avis IA" when only Gemini is set up, on the collapsed card too', async () => {
        imageGate = 'no_key';
        aiGate = 'manual';
        stubFetch();
        await script.main(ctx);
        await until(() => shadowText().includes('Voir les 5 vérifications'));
        expect(actionButton()?.textContent).toBe("Lancer l'avis IA");
        expect(hostCard()?.shadowRoot?.querySelector('.fripon > .fripon__actions')).not.toBeNull();

        await expandChecks();
        // Expanded: the image row has its guide button, the AI block its own button.
        expect(aiButton()).toBeDefined();
        expect(aiText()).toContain("L'avis de l'IA");
      }, 15_000);

      it('runs only the review on that click', async () => {
        imageGate = 'no_key';
        aiGate = 'manual';
        stubFetch();
        await script.main(ctx);
        await until(() => shadowText().includes('Voir les 5 vérifications'));
        await until(() => sentMessages('aiReview').length === 1);
        const searches = sentMessages('searchImage').length;

        aiButton()?.click();
        await expandChecks();
        await until(() => aiText().includes('Résumé de test.'));
        expect(paidReviews()).toHaveLength(1);
        // No new image request: that step has no button here.
        expect(sentMessages('searchImage')).toHaveLength(searches);
        expect(sentMessages('aiReview')[1]?.input?.signals[0]).toBe(
          "Recherche d'image : non faite.",
        );
      }, 15_000);

      it('shows a review that is already in the cache without a click and without spending', async () => {
        imageGate = 'manual';
        aiGate = 'manual';
        aiAnswer = (message) =>
          Promise.resolve(
            message.cacheOnly
              ? { status: 'ok', review: REVIEW }
              : { status: 'error', reason: 'network' },
          );
        await openCard();
        await until(() => aiText().includes('Résumé de test.'));
        expect(paidReviews()).toEqual([]);
        expect(paidSearches()).toEqual([]);
        // The image row still waits for its click.
        expect(actionButton()?.textContent).toBe("Lancer la recherche d'image");
      }, 15_000);

      it('reviews again when the click changes the image row after a cached review', async () => {
        imageGate = 'manual';
        aiGate = 'manual';
        aiAnswer = (message) =>
          Promise.resolve(
            message.cacheOnly
              ? { status: 'ok', review: { catalogPhoto: false, summary: 'Résumé du cache.' } }
              : { status: 'ok', review: { catalogPhoto: false, summary: 'Résumé à jour.' } },
          );
        await openCard();
        await until(() => aiText().includes('Résumé du cache.'));
        expect(paidReviews()).toEqual([]);

        actionButton()?.click();
        await until(() => aiText().includes('Résumé à jour.'));
        expect(shadowText()).toContain('Introuvable');
        expect(paidReviews()).toHaveLength(1);
        // The new review was asked about the result of the search the click ran.
        expect(paidReviews()[0]?.input?.signals[0]).toBe(
          "Recherche d'image : aucune trace de la photo sur Shein, Temu, AliExpress…",
        );
        expect(aiText()).not.toContain('Résumé du cache.');
      }, 15_000);

      it('keeps a cached review when the click does not change the image row', async () => {
        imageGate = 'manual';
        aiGate = 'manual';
        searchAnswer = (message) =>
          Promise.resolve(
            message.cacheOnly ? { status: 'not_cached' } : { status: 'error', reason: 'network' },
          );
        aiAnswer = (message) =>
          Promise.resolve(
            message.cacheOnly
              ? { status: 'ok', review: REVIEW }
              : { status: 'error', reason: 'network' },
          );
        await openCard();
        await until(() => aiText().includes('Résumé de test.'));

        actionButton()?.click();
        await until(() => shadowText().includes('Recherche impossible'));
        await new Promise((resolve) => setTimeout(resolve, 100));
        // The search failed: the image row still reads "not done", as it did for the cached review.
        expect(paidReviews()).toEqual([]);
        expect(aiText()).toContain('Résumé de test.');
      }, 15_000);

      it('ignores a late cache answer for an image row that has changed since', async () => {
        imageGate = 'manual';
        aiGate = 'manual';
        let cacheAnswer: (value: unknown) => void = () => undefined;
        aiAnswer = (message) =>
          message.cacheOnly
            ? new Promise((resolve) => {
                cacheAnswer = resolve;
              })
            : Promise.resolve({ status: 'ok', review: REVIEW });
        await openCard();
        await until(() => sentMessages('aiReview').length === 1);

        actionButton()?.click();
        await until(() => aiText().includes('Résumé de test.'));
        // Every step of the click is over: nothing is running, but the image row is not the same.
        cacheAnswer({ status: 'ok', review: { catalogPhoto: true, summary: 'Réponse du cache.' } });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(aiText()).toContain('Résumé de test.');
        expect(aiText()).not.toContain('Réponse du cache.');
        expect(shadowText()).not.toContain('Photo type catalogue');
      }, 15_000);

      it.each([
        ['an error', () => Promise.resolve({ status: 'error', reason: 'network' })],
        ['a miss', () => Promise.resolve({ status: 'not_cached' })],
        ['a lost message', () => Promise.reject(new Error('Extension context invalidated'))],
        ['no answer at all', () => Promise.resolve(undefined)],
      ])(
        'leaves the button alone when the look in the cache ends in %s',
        async (_name, answer) => {
          imageGate = 'no_key';
          aiGate = 'manual';
          aiAnswer = (message) =>
            message.cacheOnly ? answer() : Promise.resolve({ status: 'ok', review: REVIEW });
          stubFetch();
          await script.main(ctx);
          await until(() => shadowText().includes('Voir les 5 vérifications'));
          await until(() => sentMessages('aiReview').length === 1);
          await new Promise((resolve) => setTimeout(resolve, 100));

          expect(actionButton()?.textContent).toBe("Lancer l'avis IA");
          await expandChecks();
          expect(aiText()).not.toContain('Résumé');
          expect(aiButton()).toBeDefined();
          // The button still works.
          aiButton()?.click();
          await until(() => aiText().includes('Résumé de test.'));
        },
        15_000,
      );

      it('lets a click review even while the look in the cache has not answered', async () => {
        imageGate = 'no_key';
        aiGate = 'manual';
        aiAnswer = (message) =>
          message.cacheOnly
            ? new Promise(() => undefined)
            : Promise.resolve({ status: 'ok', review: REVIEW });
        stubFetch();
        await script.main(ctx);
        await until(() => shadowText().includes('Voir les 5 vérifications'));
        await until(() => sentMessages('aiReview').length === 1);

        actionButton()?.click();
        await expandChecks();
        await until(() => aiText().includes('Résumé de test.'));
        expect(paidReviews()).toHaveLength(1);
      }, 15_000);

      it('ignores a late cache answer once the click has started its review', async () => {
        imageGate = 'no_key';
        aiGate = 'manual';
        let cacheAnswer: (value: unknown) => void = () => undefined;
        const release = holdReview();
        const real = aiAnswer;
        aiAnswer = (message) =>
          message.cacheOnly
            ? new Promise((resolve) => {
                cacheAnswer = resolve;
              })
            : real(message);
        stubFetch();
        await script.main(ctx);
        await until(() => shadowText().includes('Voir les 5 vérifications'));
        await until(() => sentMessages('aiReview').length === 1);

        actionButton()?.click();
        await expandChecks();
        await until(() => aiText().includes("L'IA lit l'annonce…"));
        cacheAnswer({ status: 'ok', review: { catalogPhoto: true, summary: 'Réponse du cache.' } });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(aiText()).toContain("L'IA lit l'annonce…");
        expect(shadowText()).not.toContain('Photo catalogue');

        release({ status: 'ok', review: REVIEW });
        await until(() => aiText().includes('Résumé de test.'));
      }, 15_000);
    });
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

  describe('toolbar badge', () => {
    it('sends the verdict of the card once it is shown', async () => {
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));

      expect(sentMessages('setVerdictBadge')).toEqual([
        {
          type: 'setVerdictBadge',
          verdict: { level: 'clean', title: "Rien de suspect (sans recherche d'image)" },
        },
      ]);
    }, 15_000);

    it('sends the new verdict when the image search changes it', async () => {
      imageGate = 'ready';
      const answer = holdSearch();
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      expect(badgeVerdicts()).toEqual([
        { level: 'clean', title: "Rien de suspect (sans recherche d'image)" },
      ]);

      answer({ status: 'ok', matches: [SHEIN_EXACT] });
      await until(() => shadowText().includes('Article Shein revendu'));

      expect(badgeVerdicts()).toEqual([
        { level: 'clean', title: "Rien de suspect (sans recherche d'image)" },
        { level: 'resold', title: 'Article Shein revendu' },
      ]);
    }, 15_000);

    it('sends nothing more while the verdict does not change, however often the card redraws', async () => {
      aiGate = 'ready';
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      // The review redraws the card twice (it reads, then it has read) with the same verdict.
      await until(() => sentMessages('aiReview').length === 1);
      await expandChecks();
      await until(() => aiText().includes('Résumé de test.'));

      expect(sentMessages('setVerdictBadge')).toHaveLength(1);
    }, 15_000);

    it('clears the badge and sends the verdict again on a bfcache restore', async () => {
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));

      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
      await until(() => badgeVerdicts().length === 3);

      expect(badgeVerdicts().map((verdict) => verdict?.level ?? null)).toEqual([
        'clean',
        null,
        'clean',
      ]);
    }, 15_000);
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

    it('clears the badge when leaving the item page', async () => {
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      expect(badgeVerdicts()).toHaveLength(1);

      navigate('https://www.vinted.fr/catalog?search_text=robe');

      expect(badgeVerdicts().map((verdict) => verdict?.level ?? null)).toEqual(['clean', null]);
    }, 15_000);

    it('has nothing to clear when leaving before any verdict was sent', async () => {
      stubFetch();
      await script.main(ctx);
      navigate('https://www.vinted.fr/catalog?search_text=robe');
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(badgeVerdicts()).toEqual([]);
    }, 15_000);

    it('clears the badge of the old item before showing the verdict of the new one', async () => {
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));

      navigate('https://www.vinted.fr/items/9000002-autre-robe');
      await until(() => badgeVerdicts().length === 3);

      expect(badgeVerdicts().map((verdict) => verdict?.level ?? null)).toEqual([
        'clean',
        null,
        'clean',
      ]);
    }, 15_000);

    it('sends the verdict again when the page changes without changing item', async () => {
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      expect(badgeVerdicts()).toHaveLength(1);

      navigate('https://www.vinted.fr/items/9000001-robe-test?referrer=catalog');

      expect(badgeVerdicts()).toHaveLength(2);
      expect(badgeVerdicts()[1]).toEqual(badgeVerdicts()[0]);
    }, 15_000);

    it('has nothing to send again while the first analysis is still running', async () => {
      stubFetch();
      await script.main(ctx);
      navigate('https://www.vinted.fr/items/9000001-robe-test?referrer=catalog');

      expect(badgeVerdicts()).toEqual([]);
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
