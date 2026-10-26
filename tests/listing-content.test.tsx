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

type SentMessage = { type: string; url?: string; section?: string };

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

let ctx: ContentScriptContext;

beforeEach(() => {
  fakeBrowser.reset();
  (window as unknown as HappyWindow).happyDOM.setURL(ITEM_URL);
  document.head.innerHTML = '';
  document.body.innerHTML = PAGE;
  imageGate = 'no_key';
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: SentMessage) => {
    if (message.type === 'getImageGate') {
      return imageGate instanceof Error ? Promise.reject(imageGate) : Promise.resolve(imageGate);
    }
    if (message.type === 'openOptions') return Promise.resolve(undefined);
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
      rerenderPriceBlock();
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

    it('says the key is ready when the gate is open', async () => {
      imageGate = 'ready';
      stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await expandChecks();

      expect(shadowText()).toContain('Clé prête');
      expect(actionButton()).toBeNull();
    }, 15_000);

    it('runs the free checks and offers no button in manual mode', async () => {
      imageGate = 'manual';
      const calls = stubFetch();
      await script.main(ctx);
      await until(() => shadowText().includes('Voir les 5 vérifications'));
      await expandChecks();

      expect(calls.filter((url) => url.startsWith('/api/'))).toHaveLength(2);
      expect(actionButton()).toBeNull();
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
