import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardView } from '../../lib/grid/store';
import type { OptionsSection } from '../../lib/messages';
import { GridButton } from './GridButton';

const ITEM_URL = 'https://www.vinted.fr/items/9000101-robe-test';
const root = document.createElement('div');
document.body.append(root);

async function show(
  view: CardView,
  handlers: { onAnalyze?: () => void; onOpenOptions?: (section: OptionsSection) => void } = {},
) {
  await act(() =>
    render(
      <GridButton
        view={view}
        title="Robe Test"
        onAnalyze={handlers.onAnalyze ?? (() => undefined)}
        onOpenOptions={handlers.onOpenOptions ?? (() => undefined)}
      />,
      root,
    ),
  );
}

const button = () => root.querySelector('button') as HTMLButtonElement;
const text = () => root.textContent?.replace(/\s+/g, ' ').trim();

/** A click as the browser sends it: it bubbles, and it can be cancelled. */
function click(target: Element) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

afterEach(async () => {
  await act(() => render(null, root));
});

describe('GridButton', () => {
  it('offers to analyse in the idle state, with a name that says which item', async () => {
    await show({ status: 'idle' });
    expect(text()).toBe('🦊 Analyser');
    expect(button().getAttribute('aria-label')).toBe('Analyser « Robe Test » avec Fripon');
    expect(button().type).toBe('button');
  });

  it('runs the analysis on a click, and keeps the click away from the card', async () => {
    const onAnalyze = vi.fn();
    const pageListener = vi.fn();
    document.addEventListener('click', pageListener);
    await show({ status: 'idle' }, { onAnalyze });

    const event = click(button());

    document.removeEventListener('click', pageListener);
    expect(onAnalyze).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(pageListener).not.toHaveBeenCalled();
  });

  it('says it is analysing and does not start again on a click', async () => {
    const onAnalyze = vi.fn();
    await show({ status: 'running' }, { onAnalyze });
    expect(text()).toBe('⏳ Analyse…');
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(button().getAttribute('aria-disabled')).toBe('true');

    const event = click(button());
    expect(onAnalyze).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  describe('verdict', () => {
    const view = (level: 'dropshipping' | 'resold' | 'review' | 'clean'): CardView => ({
      status: 'done',
      url: ITEM_URL,
      verdict: { level, title: 'Article Shein revendu', line: 'Shein · analyse rapide' },
    });

    it('shows the title and the line, and links to the item page', async () => {
      await show(view('resold'));
      const link = root.querySelector('a') as HTMLAnchorElement;
      expect(link.href).toBe(ITEM_URL);
      expect(root.querySelector('.fripon-grid__title')?.textContent).toBe('Article Shein revendu');
      expect(root.querySelector('.fripon-grid__line')?.textContent).toBe('Shein · analyse rapide');
      expect(root.querySelector('button')).toBeNull();
    });

    it('has an accessible name that includes the verdict', async () => {
      await show(view('resold'));
      const name = root.querySelector('a')?.getAttribute('aria-label');
      expect(name).toBe(
        "Article Shein revendu. Shein · analyse rapide. Ouvrir l'analyse complète.",
      );
    });

    it.each([
      ['dropshipping', 'red'],
      ['resold', 'orange'],
      ['review', 'orange'],
      ['clean', 'green'],
    ] as const)('is %s -> %s, like the card', async (level, colour) => {
      await show(view(level));
      expect(root.querySelector('a')?.classList.contains(`fripon-grid__result--${colour}`)).toBe(
        true,
      );
    });

    it('opens the item page by itself: the click is not cancelled, only kept off the card', async () => {
      const pageListener = vi.fn();
      document.addEventListener('click', pageListener);
      await show(view('clean'));

      const event = click(root.querySelector('a') as Element);

      document.removeEventListener('click', pageListener);
      expect(event.defaultPrevented).toBe(false);
      expect(pageListener).not.toHaveBeenCalled();
    });
  });

  it('sends to the guide when there is no key', async () => {
    const onOpenOptions = vi.fn();
    await show({ status: 'needsKey', section: 'guide' }, { onOpenOptions });
    expect(text()).toBe('Activer en 2 minutes');
    const event = click(button());
    expect(onOpenOptions).toHaveBeenCalledWith('guide');
    expect(event.defaultPrevented).toBe(true);
  });

  it('sends to the keys when Google refused the key', async () => {
    const onOpenOptions = vi.fn();
    await show({ status: 'needsKey', section: 'keys' }, { onOpenOptions });
    expect(text()).toBe('Vérifier ma clé');
    click(button());
    expect(onOpenOptions).toHaveBeenCalledWith('keys');
  });

  it('sends to the credits when the cap is reached', async () => {
    const onOpenOptions = vi.fn();
    await show({ status: 'quota' }, { onOpenOptions });
    expect(text()).toBe('Plafond atteint');
    click(button());
    expect(onOpenOptions).toHaveBeenCalledWith('credits');
  });

  it('says the search was impossible and offers to try again', async () => {
    const onAnalyze = vi.fn();
    await show({ status: 'error', line: 'Recherche impossible' }, { onAnalyze });
    expect(root.querySelector('.fripon-grid__note')?.textContent).toBe('Recherche impossible');
    expect(text()).toBe('Recherche impossibleRéessayer');
    expect(button().textContent).toBe('Réessayer');
    click(button());
    expect(onAnalyze).toHaveBeenCalledOnce();
  });

  it('announces its changes politely', async () => {
    await show({ status: 'idle' });
    expect(root.querySelector('.fripon-grid')?.getAttribute('aria-live')).toBe('polite');
  });

  it('names the button without a title too', async () => {
    await act(() =>
      render(
        <GridButton
          view={{ status: 'idle' }}
          title=""
          onAnalyze={() => undefined}
          onOpenOptions={() => undefined}
        />,
        root,
      ),
    );
    expect(button().getAttribute('aria-label')).toBe('Analyser cette annonce avec Fripon');
  });
});
