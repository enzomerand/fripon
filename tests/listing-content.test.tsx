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

let ctx: ContentScriptContext;

beforeEach(() => {
  fakeBrowser.reset();
  (window as unknown as HappyWindow).happyDOM.setURL(ITEM_URL);
  document.head.innerHTML = '';
  document.body.innerHTML = PAGE;
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: { url: string }) =>
    Promise.resolve({
      ok: true,
      hash: message.url.includes('/02/') ? 'ffffffffffffffff' : '0000000000000000',
      catalogScore: 0.1,
    })) as never);
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
    expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(2);
  }, 15_000);

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
});
