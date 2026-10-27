import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuickAnalysisDeps } from '../../lib/grid/quick-analysis';
import type { SearchImageResponse } from '../../lib/messages';
import { BUTTON_HOST_TAG } from '../../lib/grid/host';
import { createGridController, type GridController } from './controller';

// A synthetic results page. Every id, name and photo is made up.
const THUMB = (n: number) => `https://images1.vinted.net/t/0${n}_aa/310x430/aa${n}.webp?s=${n}`;
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

function card(id: number, src = THUMB(id % 10)): string {
  const p = `product-item-id-${id}`;
  return `
    <div data-testid="grid-item">
      <div data-testid="${p}">
        <a data-testid="${p}--overlay-link" href="/items/${id}-robe-${id}?referrer=catalog"></a>
        <img data-testid="${p}--image--img" src="${src}">
        <div data-testid="${p}--summary">
          <div data-testid="${p}--description">
            <p data-testid="${p}--description-title">Marque ${id}</p>
            <p data-testid="${p}--description-subtitle">M · Bon état</p>
          </div>
          <p data-testid="${p}--price-text">${id % 100},00 €</p>
          <div data-testid="${p}--breakdown"><span>${id % 100},50 €</span></div>
        </div>
      </div>
    </div>`;
}

const PROMO = `
  <div data-testid="grid-item"><div data-testid="closet-promotion-7000001"></div></div>`;

const SHEIN: SearchImageResponse = {
  status: 'ok',
  matches: [
    {
      platform: 'Shein',
      url: 'https://fr.shein.com/Robe-Test-p-1234567-cat-1727.html',
      exact: true,
      price: null,
    },
  ],
};

let grid: HTMLElement;
let search: ReturnType<typeof vi.fn<QuickAnalysisDeps['searchImage']>>;
let openOptions: ReturnType<typeof vi.fn<(section: string) => void>>;
let controller: GridController | null;

function start(html: string) {
  grid.innerHTML = html;
  controller = createGridController({
    doc: document,
    css: '.fripon-grid {}',
    deps: {
      searchImage: search,
      analyzeImage: () =>
        Promise.resolve({ ok: true, hash: '0f0f0f0f0f0f0f0f', catalogScore: 0.1 }),
    },
    openOptions,
    askImageGate: () => Promise.resolve('ready'),
    askRemaining: () => Promise.resolve(40),
  });
  controller.start();
  return controller;
}

const hosts = () => [...document.querySelectorAll<HTMLElement>(BUTTON_HOST_TAG)];
const rootOf = (id: number) =>
  document.querySelector(`[data-testid="product-item-id-${id}"]`) as HTMLElement;
const hostOf = (id: number) => rootOf(id).querySelector(BUTTON_HOST_TAG) as HTMLElement | null;
const shadowText = (host: HTMLElement | null) => host?.shadowRoot?.textContent ?? '';
const shadowButton = (host: HTMLElement | null) =>
  host?.shadowRoot?.querySelector('button') as HTMLButtonElement;

async function until(predicate: () => boolean, timeoutMs = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  document.body.innerHTML = '<main><div id="grid"></div></main>';
  grid = document.getElementById('grid') as HTMLElement;
  search = vi.fn<QuickAnalysisDeps['searchImage']>(() => Promise.resolve(SHEIN));
  openOptions = vi.fn();
  controller = null;
});

afterEach(() => {
  controller?.dispose();
});

describe('placement', () => {
  it('puts one block under the price of every whole card, and none under a promotion', () => {
    start(card(9000101) + PROMO + card(9000102));
    expect(hosts()).toHaveLength(2);
    // Last in the card's text column, after the fees line that closes the price.
    const breakdown = rootOf(9000101).querySelector('[data-testid$="--breakdown"]');
    expect(breakdown?.nextElementSibling).toBe(hostOf(9000101));
    expect(hostOf(9000101)?.parentElement).toBe(breakdown?.parentElement);
    expect(rootOf(9000101).contains(hostOf(9000101))).toBe(true);
    expect(shadowText(hostOf(9000102))).toBe('🦊 Analyser');
  });

  it('is idempotent: scanning again adds nothing', () => {
    const grid = start(card(9000101) + card(9000102));
    const before = hosts();
    grid.rescan();
    grid.rescan();
    expect(hosts()).toEqual(before);
  });

  it('gives a block to the cards the page adds later (scroll, pagination)', async () => {
    start(card(9000101));
    grid.insertAdjacentHTML('beforeend', card(9000102) + card(9000103));
    await until(() => hosts().length === 3);
    expect(hostOf(9000103)).not.toBeNull();
  });

  it('takes a card that was still being drawn once its description is there', async () => {
    start(card(9000101));
    grid.insertAdjacentHTML(
      'beforeend',
      '<div data-testid="product-item-id-9000102"><a href="/items/9000102-robe"></a></div>',
    );
    await settle();
    expect(hostOf(9000102)).toBeNull();

    rootOf(9000102).insertAdjacentHTML(
      'beforeend',
      '<div data-testid="product-item-id-9000102--description"></div>',
    );
    await until(() => hostOf(9000102) !== null);
  });

  it('puts back the same block when the page drops it from a card it kept', async () => {
    start(card(9000101));
    const block = hostOf(9000101) as HTMLElement;
    block.remove();
    await until(() => hostOf(9000101) !== null);
    expect(hostOf(9000101)).toBe(block);
  });

  it('gives a block to a card the page drew again, and drops the old one', async () => {
    start(card(9000101));
    const old = hostOf(9000101);
    grid.innerHTML = card(9000101);
    await until(() => hostOf(9000101) !== null);
    expect(hostOf(9000101)).not.toBe(old);
    expect(hosts()).toHaveLength(1);
  });

  it('removes its blocks and stops watching when disposed', async () => {
    const running = start(card(9000101));
    running.dispose();
    expect(hosts()).toHaveLength(0);
    grid.insertAdjacentHTML('beforeend', card(9000102));
    await settle();
    expect(hosts()).toHaveLength(0);
  });
});

describe('analysis of a card', () => {
  it('shows the analysis running, then the compact verdict', async () => {
    let answer: (response: SearchImageResponse) => void = () => undefined;
    search.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    start(card(9000101));

    shadowButton(hostOf(9000101)).click();
    await until(() => shadowText(hostOf(9000101)).includes('Analyse…'));
    answer(SHEIN);
    await until(() => shadowText(hostOf(9000101)).includes('analyse rapide'));

    const link = hostOf(9000101)?.shadowRoot?.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toBe('Article Shein revendu' + 'Shein · analyse rapide');
    expect(new URL(link.href).pathname).toBe('/items/9000101-robe-9000101');
    expect(search).toHaveBeenCalledWith(THUMB(1), false, false);
  });

  it('keeps the click away from the card', async () => {
    const onCardClick = vi.fn();
    start(card(9000101));
    rootOf(9000101).addEventListener('click', onCardClick);
    shadowButton(hostOf(9000101)).click();
    await settle();
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('does not analyse a card twice', async () => {
    const running = start(card(9000101));
    expect(await running.analyze('9000101')).toBe('done');
    expect(await running.analyze('9000101')).toBe('skipped');
    expect(search).toHaveBeenCalledOnce();
  });

  it('does not start a card that is already being analysed', async () => {
    search.mockReturnValue(new Promise(() => undefined));
    const running = start(card(9000101));
    void running.analyze('9000101');
    expect(await running.analyze('9000101')).toBe('skipped');
    expect(search).toHaveBeenCalledOnce();
  });

  it('skips an item that is not on the page', async () => {
    const running = start(card(9000101));
    expect(await running.analyze('9000999')).toBe('skipped');
    expect(search).not.toHaveBeenCalled();
  });

  it('gives a card drawn again the verdict of its item', async () => {
    const running = start(card(9000101));
    await running.analyze('9000101');
    grid.innerHTML = card(9000101);
    await until(() => hostOf(9000101) !== null);
    expect(shadowText(hostOf(9000101))).toContain('Shein · analyse rapide');
    expect(search).toHaveBeenCalledOnce();
  });

  it('reads the thumbnail again at the click: it was a placeholder at the first look', async () => {
    const running = start(card(9000101, PLACEHOLDER));
    (rootOf(9000101).querySelector('img') as HTMLImageElement).src = THUMB(7);
    await running.analyze('9000101');
    expect(search).toHaveBeenCalledWith(THUMB(7), false, false);
  });

  it('sends nothing for a card without a usable photo, and says so apart from a failure', async () => {
    const running = start(card(9000101, PLACEHOLDER));
    expect(await running.analyze('9000101')).toBe('noPhoto');
    expect(search).not.toHaveBeenCalled();
    expect(shadowText(hostOf(9000101))).toContain('Photo indisponible');
    expect(shadowText(hostOf(9000101))).not.toContain('Recherche impossible');
  });

  it('looks at the photo again when the user clicks, and does not ask for a retry of a search that never ran', async () => {
    const running = start(card(9000101, PLACEHOLDER));
    await running.analyze('9000101');

    (rootOf(9000101).querySelector('img') as HTMLImageElement).src = THUMB(7);
    shadowButton(hostOf(9000101)).click();
    await until(() => shadowText(hostOf(9000101)).includes('analyse rapide'));
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(THUMB(7), false, false);
  });

  it('asks the background to try a failed search again, with the flag', async () => {
    search.mockResolvedValueOnce({ status: 'error', reason: 'network' });
    const running = start(card(9000101));
    expect(await running.analyze('9000101')).toBe('error');
    shadowButton(hostOf(9000101)).click();
    await until(() => shadowText(hostOf(9000101)).includes('analyse rapide'));
    expect(search).toHaveBeenLastCalledWith(THUMB(1), false, true);
  });

  it('offers to try again after a failed search', async () => {
    search.mockResolvedValueOnce({ status: 'error', reason: 'network' });
    const running = start(card(9000101));
    expect(await running.analyze('9000101')).toBe('error');
    expect(shadowButton(hostOf(9000101)).textContent).toBe('Réessayer');
  });

  it('says there is no key, and opens the guide, then asks again on the next click', async () => {
    search.mockResolvedValueOnce({ status: 'no_key' });
    const running = start(card(9000101) + card(9000102));
    expect(await running.analyze('9000101')).toBe('needsKey');
    expect(shadowButton(hostOf(9000101)).textContent).toBe('Activer en 2 minutes');

    shadowButton(hostOf(9000101)).click();
    expect(openOptions).toHaveBeenCalledWith('guide');
    // Back from the options page, the card offers to analyse again.
    await until(() => shadowText(hostOf(9000101)) === '🦊 Analyser');
  });

  it('says the cap is reached, and opens the credits', async () => {
    search.mockResolvedValueOnce({ status: 'quota' });
    const running = start(card(9000101));
    expect(await running.analyze('9000101')).toBe('quota');
    expect(shadowButton(hostOf(9000101)).textContent).toBe('Plafond atteint');
    shadowButton(hostOf(9000101)).click();
    expect(openOptions).toHaveBeenCalledWith('credits');
  });

  it('asks nothing of Vinted: only the two background requests are made', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const running = start(card(9000101));
    await running.analyze('9000101');
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lists the cards that are on the page', () => {
    const running = start(card(9000101) + card(9000102));
    expect(running.cards().map((live) => live.id)).toEqual(['9000101', '9000102']);
  });
});

describe('a card node that Vinted recycles for another item', () => {
  /** Makes the root element of one card the card of another item, node and children kept. */
  function recycle(from: number, to: number) {
    const root = rootOf(from);
    for (const element of [root, ...root.querySelectorAll('[data-testid]')]) {
      const testid = element.getAttribute('data-testid') ?? '';
      element.setAttribute('data-testid', testid.replace(`-${from}`, `-${to}`));
    }
    root.querySelector('a')?.setAttribute('href', `/items/${to}-robe-${to}`);
    return root;
  }

  it('gets a new block for the new item, which does not show the verdict of the old one', async () => {
    const running = start(card(9000101));
    await running.analyze('9000101');
    const oldBlock = hostOf(9000101) as HTMLElement;
    expect(shadowText(oldBlock)).toContain('analyse rapide');

    const root = recycle(9000101, 9000102);
    await until(() => root.querySelector(BUTTON_HOST_TAG) !== oldBlock);

    const block = root.querySelector(BUTTON_HOST_TAG) as HTMLElement;
    expect(shadowText(block)).toBe('🦊 Analyser');
    expect(oldBlock.isConnected).toBe(false);
    expect(hosts()).toHaveLength(1);
    expect(running.cards().map((live) => live.id)).toEqual(['9000102']);
  });

  it('analyses the new item from the same node, and finds the old verdict when it comes back', async () => {
    const running = start(card(9000101));
    await running.analyze('9000101');
    const root = recycle(9000101, 9000102);
    running.rescan();
    expect(await running.analyze('9000102')).toBe('done');

    recycle(9000102, 9000101);
    running.rescan();
    expect(shadowText(root.querySelector(BUTTON_HOST_TAG) as HTMLElement)).toContain(
      'analyse rapide',
    );
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('drops the block of a card that is no longer a whole card', async () => {
    const running = start(card(9000101));
    rootOf(9000101).querySelector('[data-testid$="--description"]')?.remove();
    running.rescan();
    expect(hosts()).toHaveLength(0);
    expect(running.cards()).toEqual([]);
  });
});

describe('keyboard focus', () => {
  /** The control of this block that has the focus, null when the focus is elsewhere. */
  const focused = (host: HTMLElement | null) =>
    host && document.activeElement === host ? (host.shadowRoot?.activeElement ?? null) : null;

  it('follows the button to the verdict that replaces it', async () => {
    const running = start(card(9000101));
    const button = shadowButton(hostOf(9000101));
    button.focus();
    expect(focused(hostOf(9000101))).toBe(button);

    await running.analyze('9000101');

    const link = hostOf(9000101)?.shadowRoot?.querySelector('a');
    expect(link).not.toBeNull();
    expect(focused(hostOf(9000101))).toBe(link);
  });

  it('follows the button to the retry button of a failed search', async () => {
    search.mockResolvedValueOnce({ status: 'error', reason: 'network' });
    const running = start(card(9000101));
    shadowButton(hostOf(9000101)).focus();

    await running.analyze('9000101');

    expect(shadowButton(hostOf(9000101)).textContent).toBe('Réessayer');
    expect(focused(hostOf(9000101))).toBe(shadowButton(hostOf(9000101)));
  });

  it('does not take the focus from where the user is, when the focus was not on the button', async () => {
    const running = start(card(9000101) + card(9000102));
    shadowButton(hostOf(9000102)).focus();

    await running.analyze('9000101');

    expect(focused(hostOf(9000101))).toBeNull();
    expect(focused(hostOf(9000102))).toBe(shadowButton(hostOf(9000102)));
  });
});
