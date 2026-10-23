import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OptionsSection } from '../lib/messages';
import type { CheckResult, Listing, Verdict } from '../lib/model';
import { ListingCard, PRUDENCE_NOTE, type CardState } from './ListingCard';

const listing: Listing = {
  id: '100',
  url: 'https://www.vinted.fr/items/100-robe',
  title: 'Robe',
  description: '',
  price: { amount: 12, currency: 'EUR' },
  brand: null,
  size: null,
  condition: 'unknown',
  photoUrls: ['https://images1.vinted.net/t/main/f800/main.webp?s=m'],
  sellerId: '7000001',
};

const check = (id: CheckResult['id'], overrides: Partial<CheckResult> = {}): CheckResult => ({
  id,
  status: 'ok',
  tag: 'Rassurant',
  detail: `Détail ${id}`,
  signals: [],
  ...overrides,
});

const checks: CheckResult[] = [
  check('image', { status: 'off', tag: 'Désactivée' }),
  check('price', { status: 'off', tag: 'Indisponible' }),
  check('seller', { status: 'warn', tag: 'À surveiller' }),
  check('photos', { status: 'bad', tag: 'Photo catalogue' }),
  check('description'),
];

const verdict: Verdict = {
  level: 'review',
  title: 'À vérifier',
  lines: ['Photo catalogue', 'Vendeur avec peu d’avis'],
  withoutImageSearch: true,
};

const done: CardState = { status: 'done', listing, verdict, checks };

const root = document.createElement('div');
document.body.append(root);

async function show(
  state: CardState,
  onRetry?: () => void,
  onOpenOptions?: (section: OptionsSection) => void,
) {
  await act(() =>
    render(<ListingCard state={state} onRetry={onRetry} onOpenOptions={onOpenOptions} />, root),
  );
}

afterEach(async () => {
  await act(() => render(null, root));
});

describe('ListingCard', () => {
  it('shows the loading state', async () => {
    await show({ status: 'loading' });
    expect(root.querySelector('[role="status"]')?.textContent).toBe("🦊 Fripon analyse l'annonce…");
    expect(root.querySelector('button')).toBeNull();
  });

  it('shows the collapsed verdict with its toggle', async () => {
    await show(done);
    const card = root.querySelector('.fripon');
    expect(card?.classList.contains('fripon--orange')).toBe(true);
    expect(card?.textContent).toContain('À vérifier');
    expect(card?.textContent).toContain('Photo catalogue');
    const toggle = root.querySelector('button');
    expect(toggle?.textContent).toBe('Voir les 5 vérifications');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.fripon__check')).toBeNull();
    expect(root.textContent).not.toContain(PRUDENCE_NOTE);
  });

  it('maps verdict levels to colours', async () => {
    const level = async (l: Verdict['level']) => {
      await show({ ...done, verdict: { ...verdict, level: l } });
      return root.querySelector('.fripon')?.className;
    };
    expect(await level('dropshipping')).toContain('fripon--red');
    expect(await level('resold')).toContain('fripon--orange');
    expect(await level('clean')).toContain('fripon--green');
  });

  it('expands on click and lists every check with the prudence note', async () => {
    await show(done);
    const toggle = root.querySelector('button') as HTMLButtonElement;
    await act(() => toggle.click());

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Masquer les vérifications');
    expect(toggle.getAttribute('aria-controls')).toBe(root.querySelector('div[id]')?.id);

    const rows = [...root.querySelectorAll('.fripon__check')];
    expect(rows.map((row) => row.querySelector('.fripon__check-head span')?.textContent)).toEqual([
      "Recherche de l'image",
      'Prix',
      'Vendeur',
      'Photos',
      'Description',
    ]);
    expect(rows[3]?.querySelector('.fripon__tag--bad')?.textContent).toBe('Photo catalogue');
    expect(rows[2]?.querySelector('.fripon__tag--mid')).not.toBeNull();
    expect(rows[0]?.querySelector('.fripon__tag--off')).not.toBeNull();
    expect(rows[4]?.querySelector('.fripon__tag--ok')).not.toBeNull();
    expect(rows[3]?.textContent).toContain('Détail photos');
    expect(root.textContent).toContain(PRUDENCE_NOTE);

    await act(() => toggle.click());
    expect(root.querySelector('.fripon__check')).toBeNull();
  });

  it('gives the image row a Google Lens link opening in a new tab', async () => {
    await show(done);
    await act(() => (root.querySelector('button') as HTMLButtonElement).click());

    const links = root.querySelectorAll('a');
    expect(links).toHaveLength(1);
    const link = links[0] as HTMLAnchorElement;
    expect(link.textContent).toBe('Chercher moi-même sur Google Lens');
    expect(link.getAttribute('href')).toBe(
      'https://lens.google.com/uploadbyurl?url=' +
        encodeURIComponent(listing.photoUrls[0] as string),
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(root.querySelector('.fripon__check')?.contains(link)).toBe(true);
  });

  describe('check actions', () => {
    const withImage = (overrides: Partial<CheckResult>): CardState => ({
      ...done,
      checks: [
        check('image', { status: 'off', tag: 'Désactivée', ...overrides }),
        ...checks.slice(1),
      ],
    });
    const expand = () =>
      act(() => (root.querySelector('.fripon__toggle') as HTMLButtonElement).click());
    const actionButton = () => root.querySelector('.fripon__check .fripon__action');

    it('shows "Activer en 2 minutes" on a check with the guide action, and opens the guide', async () => {
      const open = vi.fn();
      await show(withImage({ action: 'open_guide' }), undefined, open);
      await expand();

      const button = actionButton() as HTMLButtonElement;
      expect(button.tagName).toBe('BUTTON');
      expect(button.type).toBe('button');
      expect(button.textContent).toBe('Activer en 2 minutes');
      expect(root.querySelector('.fripon__check')?.contains(button)).toBe(true);

      await act(() => button.click());
      expect(open).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith('guide');
    });

    it('shows "Voir mes réglages" on the settings action, and opens the credits', async () => {
      const open = vi.fn();
      await show(withImage({ action: 'open_settings', tag: 'Plafond atteint' }), undefined, open);
      await expand();

      const button = actionButton() as HTMLButtonElement;
      expect(button.textContent).toBe('Voir mes réglages');
      await act(() => button.click());
      expect(open).toHaveBeenCalledWith('credits');
    });

    it('keeps the Lens link as the one and only link beside the button', async () => {
      await show(withImage({ action: 'open_guide' }), undefined, vi.fn());
      await expand();
      const links = root.querySelectorAll('a');
      expect(links).toHaveLength(1);
      expect(links[0]?.textContent).toBe('Chercher moi-même sur Google Lens');
    });

    it('has no button for a check without an action', async () => {
      await show(withImage({}), undefined, vi.fn());
      await expand();
      expect(actionButton()).toBeNull();
    });

    it('has no button when nobody handles the click', async () => {
      await show(withImage({ action: 'open_guide' }));
      await expand();
      expect(actionButton()).toBeNull();
      expect(root.querySelectorAll('a')).toHaveLength(1);
    });

    it('shows the button without the Lens link when the listing has no photo', async () => {
      const state = withImage({ action: 'open_guide' }) as Extract<CardState, { status: 'done' }>;
      await show({ ...state, listing: { ...listing, photoUrls: [] } }, undefined, vi.fn());
      await expand();
      expect(actionButton()).not.toBeNull();
      expect(root.querySelector('a')).toBeNull();
    });
  });

  it('omits the Lens link when the listing has no photo', async () => {
    await show({ ...done, listing: { ...listing, photoUrls: [] } });
    await act(() => (root.querySelector('button') as HTMLButtonElement).click());
    expect(root.querySelector('a')).toBeNull();
  });

  it('shows the error state with a retry button', async () => {
    const retry = vi.fn();
    await show({ status: 'error', message: 'Vinted a changé sa page.' }, retry);
    expect(root.textContent).toContain("Fripon n'a pas pu analyser cette annonce.");
    expect(root.textContent).toContain('Vinted a changé sa page.');
    await act(() => (root.querySelector('button') as HTMLButtonElement).click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it('has no retry button without a handler', async () => {
    await show({ status: 'error', message: 'x' });
    expect(root.querySelector('button')).toBeNull();
  });
});
