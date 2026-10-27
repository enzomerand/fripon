import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import script from '../entrypoints/grid.content';
import { VINTED_ITEM_MATCHES, VINTED_PAGE_MATCHES } from '../lib/vinted/domains';

// Integration test of the grid content script on a synthetic results page. Every id and name is
// made up.
type HappyWindow = import('happy-dom').Window;

const CATALOG_URL = 'https://www.vinted.fr/catalog?search_text=robe';
const THUMB = 'https://images1.vinted.net/t/01_aa/310x430/aa.webp?s=1';

function card(id: number): string {
  const p = `product-item-id-${id}`;
  return `
    <div data-testid="grid-item">
      <div data-testid="${p}">
        <a data-testid="${p}--overlay-link" href="/items/${id}-robe-test"></a>
        <img data-testid="${p}--image--img" src="${THUMB}">
        <div data-testid="${p}--description">
          <p data-testid="${p}--description-title">Marque Test</p>
          <p data-testid="${p}--price-text">12,00 €</p>
        </div>
      </div>
    </div>`;
}

type Sent = {
  type: string;
  photoUrl?: string;
  cacheOnly?: boolean;
  section?: string;
  url?: string;
};

let searchAnswer: unknown;
let ctx: ContentScriptContext;

const hosts = () => [...document.querySelectorAll('fripon-grid-button')] as HTMLElement[];
const shadowText = (host: Element | undefined) => host?.shadowRoot?.textContent ?? '';
const sent = (type: string): Sent[] =>
  vi
    .mocked(browser.runtime.sendMessage)
    .mock.calls.map(([message]) => message as unknown as Sent)
    .filter((message) => message.type === type);

async function until(predicate: () => boolean, timeoutMs = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  fakeBrowser.reset();
  (window as unknown as HappyWindow).happyDOM.setURL(CATALOG_URL);
  document.head.innerHTML = '';
  document.body.innerHTML = `<main><div id="grid">${card(9000101)}${card(9000102)}</div></main>`;
  searchAnswer = { status: 'ok', matches: [] };
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: Sent) => {
    if (message.type === 'searchImage') return Promise.resolve(searchAnswer);
    if (message.type === 'openOptions') return Promise.resolve(undefined);
    return Promise.resolve({ ok: true, hash: '0f0f0f0f0f0f0f0f', catalogScore: 0.1 });
  }) as never);
  ctx = new ContentScriptContext('grid', { matches: [] });
});

afterEach(() => {
  ctx.notifyInvalidated();
  vi.restoreAllMocks();
});

describe('grid content script', () => {
  it('runs on every page of Vinted except the item pages, which have their own card', () => {
    expect(script.matches).toEqual(VINTED_PAGE_MATCHES);
    expect(script.excludeMatches).toEqual(VINTED_ITEM_MATCHES);
  });

  it('puts a button under every card, and asks nothing before a click', async () => {
    await script.main(ctx);
    expect(hosts()).toHaveLength(2);
    expect(hosts().map((host) => shadowText(host))).toEqual(['🦊 Analyser', '🦊 Analyser']);
    expect(vi.mocked(browser.runtime.sendMessage)).not.toHaveBeenCalled();
  });

  it('searches the thumbnail on a click and shows the compact verdict', async () => {
    await script.main(ctx);
    (hosts()[0]?.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    await until(() => shadowText(hosts()[0]).includes('analyse rapide'));

    expect(shadowText(hosts()[0])).toContain('Rien trouvé · analyse rapide');
    // A click is a real search, not a look in the cache; the other card was not touched.
    expect(sent('searchImage')).toEqual([{ type: 'searchImage', photoUrl: THUMB }]);
    expect(sent('analyzeImage')).toEqual([{ type: 'analyzeImage', url: THUMB }]);
    expect(shadowText(hosts()[1])).toBe('🦊 Analyser');
  });

  it('opens the guide when there is no key', async () => {
    searchAnswer = { status: 'no_key' };
    await script.main(ctx);
    (hosts()[0]?.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    await until(() => shadowText(hosts()[0]).includes('Activer en 2 minutes'));

    (hosts()[0]?.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    expect(sent('openOptions')).toEqual([{ type: 'openOptions', section: 'guide' }]);
  });

  it('puts the buttons back when the page comes back from the bfcache', async () => {
    await script.main(ctx);
    hosts()[0]?.remove();
    const restored = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    // At once, without waiting for the observer's next frame.
    expect(hosts()).toHaveLength(2);
  });

  it('removes its buttons when the extension is invalidated', async () => {
    await script.main(ctx);
    ctx.notifyInvalidated();
    expect(hosts()).toHaveLength(0);
  });
});
