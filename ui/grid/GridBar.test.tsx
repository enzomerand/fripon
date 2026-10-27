import { readFileSync } from 'node:fs';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatchState } from '../../lib/grid/batch';
import { GridBar, confirmText, endNotice, focusTargetOf } from './GridBar';

// The stylesheet as written: happy-dom lays nothing out, so the rule itself is what is checked.
const css = readFileSync('ui/grid/grid.css', 'utf8');

const root = document.createElement('div');
document.body.append(root);

function handlers() {
  return { onAsk: vi.fn(), onLaunch: vi.fn(), onCancel: vi.fn(), onStop: vi.fn() };
}

async function show(batch: BatchState, visibleCount = 24, on = handlers()) {
  await act(() => render(<GridBar visibleCount={visibleCount} batch={batch} {...on} />, root));
  return on;
}

const idle: BatchState = { phase: 'idle', last: null };
const text = () => root.textContent?.trim();
const buttons = () => [...root.querySelectorAll('button')];

afterEach(async () => {
  await act(() => render(null, root));
});

describe('GridBar', () => {
  it('offers to analyse the cards in view', async () => {
    const on = await show(idle, 24);
    expect(text()).toBe('Analyser les 24 articles visibles');
    buttons()[0]?.click();
    expect(on.onAsk).toHaveBeenCalledOnce();
  });

  it('separates the fox from the label: its own item and a gap in the flex row', async () => {
    await show(idle, 24);
    expect(buttons()[0]?.firstElementChild?.querySelector('svg')).toBeTruthy();
    const rule = /\.fripon-bar__button \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(rule).toMatch(/display:\s*inline-flex/);
    expect(rule).toMatch(/gap:\s*\d+px/);
  });

  it('speaks of one card in the singular', async () => {
    await show(idle, 1);
    expect(text()).toBe("Analyser l'article visible");
  });

  it('asks to confirm, with the cost and the credits left', async () => {
    const on = await show({ phase: 'confirm', total: 24, remaining: 640 });
    expect(root.querySelector('p')?.textContent).toBe(
      "Jusqu'à 24 crédits Vision (il t'en reste 640 ce mois-ci).",
    );
    expect(buttons().map((button) => button.textContent)).toEqual(['Lancer', 'Annuler']);
    buttons()[0]?.click();
    buttons()[1]?.click();
    expect(on.onLaunch).toHaveBeenCalledOnce();
    expect(on.onCancel).toHaveBeenCalledOnce();
    expect(on.onAsk).not.toHaveBeenCalled();
  });

  it('shows the progress and a button to stop', async () => {
    const on = await show({ phase: 'running', total: 24, position: 7, stopping: false });
    expect(root.querySelector('p')?.textContent).toBe('Analyse en cours : 7 / 24');
    expect(buttons().map((button) => button.textContent)).toEqual(['Arrêter']);
    buttons()[0]?.click();
    expect(on.onStop).toHaveBeenCalledOnce();
  });

  it('says it is stopping once asked to', async () => {
    await show({ phase: 'running', total: 24, position: 7, stopping: true });
    expect(root.querySelector('p')?.textContent).toBe('Arrêt en cours…');
    expect(buttons()[0]?.getAttribute('aria-disabled')).toBe('true');
  });

  it('says why the last batch stopped, above the button', async () => {
    await show({ phase: 'idle', last: { reason: 'quota', analysed: 5 } }, 12);
    expect(root.querySelector('p')?.textContent).toBe(
      "Plafond atteint : les articles restants n'ont pas été analysés.",
    );
    expect(buttons()[0]?.textContent).toBe('Analyser les 12 articles visibles');
  });

  it('is a labelled region', async () => {
    await show(idle);
    expect(root.firstElementChild?.getAttribute('role')).toBe('region');
    expect(root.firstElementChild?.getAttribute('aria-label')).toContain('Fripon');
  });
});

describe('confirmText', () => {
  it('uses the singular for one credit', () => {
    expect(confirmText(1, 3)).toBe("Jusqu'à 1 crédit Vision (il t'en reste 3 ce mois-ci).");
  });

  it('says what is left even when nothing is', () => {
    expect(confirmText(5, 0)).toBe("Jusqu'à 5 crédits Vision (il t'en reste 0 ce mois-ci).");
  });

  it('leaves out the credits left when they are not known (no cap)', () => {
    expect(confirmText(5, null)).toBe("Jusqu'à 5 crédits Vision.");
  });
});

describe('endNotice', () => {
  it('says nothing of a batch that went through, or of none', () => {
    expect(endNotice(null)).toBeNull();
    expect(endNotice({ reason: 'finished', analysed: 4 })).toBeNull();
  });

  it.each([
    ['quota', 'Plafond atteint'],
    ['needsKey', 'Clé Google à vérifier'],
    ['failures', 'Plusieurs recherches ont échoué'],
  ] as const)('explains a stop on %s', (reason, start) => {
    expect(endNotice({ reason, analysed: 2 })).toContain(start);
  });

  it('counts the cards analysed before the user stopped it', () => {
    expect(endNotice({ reason: 'stopped', analysed: 1 })).toBe('Analyse arrêtée après 1 article.');
    expect(endNotice({ reason: 'stopped', analysed: 6 })).toBe('Analyse arrêtée après 6 articles.');
  });
});

describe('focusTargetOf', () => {
  it('is the safe answer of a confirmation and the stop of a running batch', () => {
    expect(focusTargetOf({ phase: 'confirm', total: 3, remaining: 5 })).toBe('cancel');
    expect(focusTargetOf({ phase: 'running', total: 3, position: 1, stopping: false })).toBe(
      'stop',
    );
  });

  it('is the bar once a batch has ended, the button before any', () => {
    expect(focusTargetOf({ phase: 'idle', last: { reason: 'quota', analysed: 2 } })).toBe('region');
    expect(focusTargetOf({ phase: 'idle', last: null })).toBe('ask');
  });
});
