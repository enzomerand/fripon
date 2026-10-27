import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageGate } from '../../lib/gate';
import { BAR_HOST_TAG, BUTTON_HOST_TAG } from '../../lib/grid/host';
import type { QuickAnalysisDeps } from '../../lib/grid/quick-analysis';
import type { SearchImageResponse } from '../../lib/messages';
import { createGridController, type GridController } from './controller';

// The bar above the results, on a synthetic results page. Every id and photo is made up.
const THUMB = (id: number) => `https://images1.vinted.net/t/01_aa/310x430/p${id}.webp?s=1`;

function card(id: number, src = THUMB(id)): string {
  const p = `product-item-id-${id}`;
  return `
    <div data-testid="grid-item">
      <div data-testid="${p}">
        <a data-testid="${p}--overlay-link" href="/items/${id}-robe-test"></a>
        <img data-testid="${p}--image--img" src="${src}">
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

function start(html = IDS.map((id) => card(id)).join('')) {
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
    main.innerHTML = `<h1>Résultats</h1><div id="grid">${IDS.map((id) => card(id)).join('')}</div>`;
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

describe('cards without a photo', () => {
  const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  // Four cards whose first three thumbnails have not loaded: no search can be sent for them.
  const html = [
    card(9000101, PLACEHOLDER),
    card(9000102, PLACEHOLDER),
    card(9000103, PLACEHOLDER),
    card(9000104),
  ].join('');

  it('do not end the batch as a series of failures would, and do not count as analysed', async () => {
    start(html);
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
    barButton('Lancer').click();
    await until(() => cardText(9000104).includes('analyse rapide'));

    expect(search).toHaveBeenCalledOnce();
    expect(cardText(9000101)).toContain('Photo indisponible');
    // Nothing was searched for the first three cards: no pause for them either.
    expect(sleeps).toEqual([]);
  });

  it('are not among the cards "analysed" when the user stops the batch', async () => {
    let releasePause: () => void = () => undefined;
    sleep = () => new Promise<void>((resolve) => (releasePause = resolve));
    start([card(9000101, PLACEHOLDER), card(9000102), card(9000103), card(9000104)].join(''));
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
    barButton('Lancer').click();
    await until(() => search.mock.calls.length === 1);
    await until(() => barText().includes('1 / 4') || barText().includes('2 / 4'));

    barButton('Arrêter').click();
    await until(() => barText().includes('Analyse arrêtée'));
    releasePause();
    expect(barText()).toContain('Analyse arrêtée après 1 article.');
  });

  it('are not counted among the cards a batch would take once the user has looked at them', async () => {
    const running = start(html);
    await until(() => barText() === '🦊 Analyser les 4 articles visibles');
    await running.analyze('9000101');
    // The first card, now "Photo indisponible", is left to a click of its own.
    await until(() => barText() === '🦊 Analyser les 3 articles visibles');
  });
});

describe('on the shape of the live search page', () => {
  // Cards in `div.feed-grid` inside `section.content-container` (the real class names carry a
  // hashed prefix), the bar before the grid, as seen on vinted.fr.
  const PAGE = `
    <div id="app"><main>
      <section class="Ab1c_content-container">
        <div id="grid" class="Xy9z_feed-grid"></div>
      </section>
    </main></div>`;

  const section = () => document.querySelector('section') as HTMLElement;
  const gridOf = (...ids: number[]) => {
    const grid = document.createElement('div');
    grid.id = 'grid';
    grid.className = 'Xy9z_feed-grid';
    grid.innerHTML = ids.map((id) => card(id)).join('');
    return grid;
  };

  beforeEach(() => {
    document.body.innerHTML = PAGE;
  });

  async function openConfirmation() {
    start();
    await until(() => bar() !== null);
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
  }

  it('is put in the section, right before the grid', async () => {
    start();
    await until(() => bar() !== null);
    expect(bar()?.parentElement).toBe(section());
    expect(bar()?.nextElementSibling).toBe(document.getElementById('grid'));
  });

  it('shows the confirmation on a click, and the page never hears of the click', async () => {
    // A page whose click handlers re-render the results, as Vinted may on a click it does not know.
    const pageClick = vi.fn(() => section().replaceChildren(gridOf(...IDS)));
    document.addEventListener('click', pageClick);
    try {
      await openConfirmation();
      await settle();
      expect(pageClick).not.toHaveBeenCalled();
      expect(document.querySelectorAll(BAR_HOST_TAG)).toHaveLength(1);
      expect(barText()).toContain("Jusqu'à 4 crédits Vision");
    } finally {
      document.removeEventListener('click', pageClick);
    }
  });

  it('keeps the confirmation when the page redraws the whole results section', async () => {
    await openConfirmation();
    const host = bar();

    // What a re-render of the section does: the grid, and the bar with it, are dropped for new ones.
    section().replaceChildren(gridOf(...IDS));
    expect(bar()).toBeNull();

    await until(() => bar() !== null);
    // The same host, shadow tree and batch state: the user is still asked to confirm.
    expect(bar()).toBe(host);
    expect(barText()).toContain("Jusqu'à 4 crédits Vision (il t'en reste 40 ce mois-ci).");
    expect(bar()?.parentElement).toBe(section());
    expect(bar()?.nextElementSibling).toBe(document.getElementById('grid'));
    // The new cards have their buttons again, and the old ones are gone.
    expect(document.querySelectorAll(BUTTON_HOST_TAG)).toHaveLength(4);
  });

  it('puts the bar back when the page drops it alone, whatever the state', async () => {
    await openConfirmation();
    bar()?.remove();
    await until(() => bar() !== null);
    expect(barText()).toContain('Lancer');

    barButton('Annuler').click();
    await until(() => barText().includes('Analyser les 4'));
    bar()?.remove();
    await until(() => barText().includes('Analyser les 4'));
  });

  it('keeps going when the page redraws the section in the middle of a batch', async () => {
    await openConfirmation();
    barButton('Lancer').click();
    await until(() => search.mock.calls.length >= 1);

    section().replaceChildren(gridOf(...IDS));
    await until(() => bar() !== null);
    // Cards analysed before the redraw keep their verdict on the new cards.
    await until(() => cardText(9000101).includes('analyse rapide'));
  });

  it('does not take a card the page has dropped for a live one', async () => {
    const running = start();
    await until(() => bar() !== null);
    const old = running.cards().map((live) => live.element);
    section().replaceChildren(gridOf(...IDS));
    // Before the next pass the controller may still know the old cards: it must not hand them out.
    expect(running.cards().every((live) => live.element.isConnected)).toBe(true);
    expect(old.every((element) => !element.isConnected)).toBe(true);
  });
});

describe('keyboard focus in the bar', () => {
  const focusedControl = () => bar()?.shadowRoot?.activeElement?.getAttribute('data-focus') ?? null;

  /** Focuses a control and clicks it, as a keyboard user pressing Enter on it does. */
  function press(label: string) {
    const button = barButton(label);
    button.focus();
    button.click();
  }

  it('goes to the safe answer of the confirmation, then to "Arrêter" once launched', async () => {
    let release: () => void = () => undefined;
    sleep = () => new Promise<void>((resolve) => (release = resolve));
    start();
    await until(() => bar() !== null);

    press('Analyser');
    await until(() => barText().includes('Lancer'));
    expect(focusedControl()).toBe('cancel');

    press('Lancer');
    await until(() => barText().includes('Analyse en cours'));
    expect(focusedControl()).toBe('stop');

    barButton('Arrêter').click();
    await until(() => barText().includes('Analyse arrêtée'));
    release();
  });

  it('goes back to the button after a cancel', async () => {
    start();
    await until(() => bar() !== null);
    press('Analyser');
    await until(() => barText().includes('Lancer'));
    press('Annuler');
    await until(() => barText().includes('Analyser les 4'));
    expect(focusedControl()).toBe('ask');
  });

  it('goes to the bar itself when a batch ends and the bar has something to say', async () => {
    search.mockResolvedValueOnce(FOUND).mockResolvedValueOnce({ status: 'quota' });
    start();
    await until(() => bar() !== null);
    press('Analyser');
    await until(() => barText().includes('Lancer'));
    press('Lancer');
    await until(() => barText().includes('Plafond atteint'));
    expect(focusedControl()).toBe('region');
  });

  it('goes to the first block of the page when the bar leaves with the end of the batch', async () => {
    start();
    await until(() => bar() !== null);
    press('Analyser');
    await until(() => barText().includes('Lancer'));
    press('Lancer');
    await until(() => bar() === null);

    const block = document.querySelector(BUTTON_HOST_TAG) as HTMLElement;
    const link = block.shadowRoot?.querySelector('a');
    expect(link).not.toBeNull();
    expect(document.activeElement).toBe(block);
    expect(block.shadowRoot?.activeElement).toBe(link);
  });

  it('does not take the focus when it was not in the bar', async () => {
    start();
    await until(() => bar() !== null);
    // Mouse user: the click does not focus, and nothing else of the page is focused either.
    barButton('Analyser').click();
    await until(() => barText().includes('Lancer'));
    expect(focusedControl()).toBeNull();
  });
});
