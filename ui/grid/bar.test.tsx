import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageGate } from '../../lib/gate';
import { BAR_HOST_TAG, BUTTON_HOST_TAG } from '../../lib/grid/host';
import type { QuickAnalysisDeps } from '../../lib/grid/quick-analysis';
import type { SearchImageResponse } from '../../lib/messages';
import { createGridController, type GridController } from './controller';

// The bar above the results, on a synthetic results page. Every id and photo is made up.
const THUMB = (id: number) => `https://images1.vinted.net/t/01_aa/310x430/p${id}.webp?s=1`;

function card(id: number): string {
  const p = `product-item-id-${id}`;
  return `
    <div data-testid="grid-item">
      <div data-testid="${p}">
        <a data-testid="${p}--overlay-link" href="/items/${id}-robe-test"></a>
        <img data-testid="${p}--image--img" src="${THUMB(id)}">
        <div data-testid="${p}--description"><p data-testid="${p}--price-text">9,00 €</p></div>
      </div>
    </div>`;
}

const FOUND: SearchImageResponse = { status: 'ok', matches: [] };
const IDS = [9000101, 9000102, 9000103, 9000104];

let search: ReturnType<typeof vi.fn<QuickAnalysisDeps['searchImage']>>;
let gate: ImageGate;
let remaining: number | null;
let sleeps: number[];
let sleep: (ms: number) => Promise<void>;
/** Ids that count as in view. */
let inView: Set<number>;
let controller: GridController | null;

function start(html = IDS.map(card).join('')) {
  document.getElementById('grid')!.innerHTML = html;
  controller = createGridController({
    doc: document,
    css: '',
    deps: {
      searchImage: search,
      analyzeImage: () =>
        Promise.resolve({ ok: true, hash: '0f0f0f0f0f0f0f0f', catalogScore: 0.1 }),
    },
    openOptions: vi.fn(),
    askImageGate: () => Promise.resolve(gate),
    askRemaining: () => Promise.resolve(remaining),
    sleep,
    isShown: (element) =>
      inView.has(Number(element.getAttribute('data-testid')?.replace('product-item-id-', ''))),
  });
  controller.start();
  return controller;
}

const bar = () => document.querySelector(BAR_HOST_TAG) as HTMLElement | null;
const barText = () => bar()?.shadowRoot?.textContent?.trim() ?? '';
const barButton = (label: string) =>
  [...(bar()?.shadowRoot?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.includes(label),
  ) as HTMLButtonElement;
const cardText = (id: number) =>
  document.querySelector(`[data-testid="product-item-id-${id}"] ${BUTTON_HOST_TAG}`)?.shadowRoot
    ?.textContent ?? '';

async function until(predicate: () => boolean, timeoutMs = 2_000) {
  const begin = Date.now();
  while (!predicate()) {
    if (Date.now() - begin > timeoutMs) throw new Error(`Timed out: ${barText()}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

beforeEach(() => {
  document.body.innerHTML = '<main><h1>Résultats</h1><div id="grid"></div><nav></nav></main>';
  search = vi.fn<QuickAnalysisDeps['searchImage']>(() => Promise.resolve(FOUND));
  gate = 'ready';
  remaining = 40;
  sleeps = [];
  sleep = (ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  inView = new Set(IDS);
  controller = null;
});

afterEach(() => {
  controller?.dispose();
});

describe('the bar above the results', () => {
  it('is put before the grid, and counts the cards in view', async () => {
    inView = new Set([9000101, 9000102, 9000103]);
    start();
    await until(() => bar() !== null);
    expect(bar()?.nextElementSibling).toBe(document.getElementById('grid'));
    expect(barText()).toBe('🦊 Analyser les 3 articles visibles');
  });

  it('is not there without a Vision key', async () => {
    gate = 'no_key';
    start();
    await settle();
    expect(bar()).toBeNull();
  });

  it('is there when the cap is reached: cached photos still cost nothing', async () => {
    gate = 'quota';
    start();
    await until(() => bar() !== null);
  });

  it('is not there when no card is in view', async () => {
    inView = new Set();
    start();
    await settle();
    expect(bar()).toBeNull();
  });

  it('follows the scroll: the cards in view are counted again', async () => {
    inView = new Set([9000101]);
    start();
    await until(() => barText() === "🦊 Analyser l'article visible");

    inView = new Set([9000102, 9000103]);
    window.dispatchEvent(new Event('scroll'));
    await until(() => barText() === '🦊 Analyser les 2 articles visibles');

    inView = new Set();
    window.dispatchEvent(new Event('scroll'));
    await until(() => bar() === null);
  });

  it('does not count the cards that already have a verdict, or are being analysed', async () => {
    const running = start();
    await running.analyze('9000101');
    await until(() => barText() === '🦊 Analyser les 3 articles visibles');
  });

  it('comes back when the key is added, as the user returns to the tab', async () => {
    gate = 'no_key';
    start();
    await settle();
    expect(bar()).toBeNull();

    gate = 'ready';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await until(() => bar() !== null);
  });

  it('is put back before the grid when the page replaces the grid', async () => {
    start();
    await until(() => bar() !== null);
    const main = document.querySelector('main') as HTMLElement;
    main.innerHTML = `<h1>Résultats</h1><div id="grid">${IDS.map(card).join('')}</div>`;
    await until(() => bar()?.nextElementSibling === document.getElementById('grid'));
    expect(document.querySelectorAll(BAR_HOST_TAG)).toHaveLength(1);
  });

  it('is removed with the controller', async () => {
    const running = start();
    await until(() => bar() !== null);
    running.dispose();
    expect(bar()).toBeNull();
  });
});

describe('a batch', () => {
  it('asks for confirmation first, with the credits it may cost and those that are left', async () => {
    start();
    await until(() => bar() !== null);
    barButton('Analyser les 4').click();
    await until(() => barText().includes('Jusqu'));
    expect(barText()).toContain("Jusqu'à 4 crédits Vision (il t'en reste 40 ce mois-ci).");
    expect(search).not.toHaveBeenCalled();
  });

  it('starts nothing when cancelled', async () => {
    start();
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
    barButton('Annuler').click();
    await until(() => barText().includes('Analyser les 4'));
    expect(search).not.toHaveBeenCalled();
    expect(cardText(9000101)).toBe('🦊 Analyser');
  });

  it('analyses the cards in view one by one, in page order, then goes away', async () => {
    inView = new Set([9000102, 9000103, 9000104]);
    start();
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
    barButton('Lancer').click();
    await until(() => bar() === null);

    expect(search.mock.calls.map(([photoUrl]) => photoUrl)).toEqual([
      THUMB(9000102),
      THUMB(9000103),
      THUMB(9000104),
    ]);
    // A second between two analyses, none after the last, none for the card that was out of view.
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(cardText(9000101)).toBe('🦊 Analyser');
    expect(cardText(9000102)).toContain('analyse rapide');
    expect(cardText(9000104)).toContain('analyse rapide');
  });

  it('shows the progress and lets the user stop it', async () => {
    let releasePause: () => void = () => undefined;
    sleep = () => new Promise<void>((resolve) => (releasePause = resolve));
    start();
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
    barButton('Lancer').click();
    await until(() => barText().startsWith('Analyse en cours : 1 / 4'));
    expect(barButton('Arrêter')).toBeDefined();

    barButton('Arrêter').click();
    await until(() => barText().startsWith('Analyse arrêtée après 1 article.'));
    releasePause();

    expect(search).toHaveBeenCalledOnce();
    // The cards that were not reached keep their button.
    expect(cardText(9000102)).toBe('🦊 Analyser');
    expect(barText()).toContain('🦊 Analyser les 3 articles visibles');
  });

  it('stops at the cap, and the cards that remain keep their button', async () => {
    search
      .mockResolvedValueOnce(FOUND)
      .mockResolvedValueOnce({ status: 'quota' })
      .mockResolvedValue(FOUND);
    start();
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
    barButton('Lancer').click();
    await until(() => barText().includes('Plafond atteint'));

    expect(search).toHaveBeenCalledTimes(2);
    expect(cardText(9000101)).toContain('analyse rapide');
    expect(cardText(9000102)).toBe('Plafond atteint');
    expect(cardText(9000103)).toBe('🦊 Analyser');
    expect(cardText(9000104)).toBe('🦊 Analyser');
  });

  it('goes on after a failed card', async () => {
    search.mockResolvedValueOnce({ status: 'error', reason: 'network' });
    start();
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
    barButton('Lancer').click();
    await until(() => search.mock.calls.length === 4);
    await until(() => cardText(9000104).includes('analyse rapide'));
    expect(cardText(9000101)).toContain('Recherche impossible');
  });

  it('stops when there is no key, and hides the bar', async () => {
    // As the background would: the key is gone for the next question about the gate too.
    search.mockImplementation(() => {
      gate = 'no_key';
      return Promise.resolve({ status: 'no_key' });
    });
    start();
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
    barButton('Lancer').click();
    await until(() => cardText(9000101) === 'Activer en 2 minutes');
    await until(() => bar() === null);
    expect(search).toHaveBeenCalledOnce();
  });

  it('takes the cards in view at the time of the click, not at launch', async () => {
    start();
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
    // The user scrolls while the confirmation waits: what was announced is what runs.
    inView = new Set();
    window.dispatchEvent(new Event('scroll'));
    await settle();
    expect(barText()).toContain('Lancer');
    barButton('Lancer').click();
    await until(() => search.mock.calls.length === 4);
  });

  it('does not take a card that was analysed by hand in the meantime', async () => {
    const running = start();
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
    await running.analyze('9000102');
    barButton('Lancer').click();
    await until(() => bar() === null);
    // Four cards, one done by hand: three more searches.
    expect(search).toHaveBeenCalledTimes(4);
  });

  it('does not say "il t\'en reste" without a cap', async () => {
    remaining = null;
    start();
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Jusqu'));
    expect(barText()).toContain("Jusqu'à 4 crédits Vision.");
    expect(barText()).not.toContain('reste');
  });
});
