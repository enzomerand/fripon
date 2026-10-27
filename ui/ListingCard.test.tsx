import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiBlock } from '../lib/ai/block';
import type { OptionsSection } from '../lib/messages';
import type { CheckResult, ImageMatch, Listing, Verdict } from '../lib/model';
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
  onRun?: () => void,
) {
  await act(() =>
    render(
      <ListingCard state={state} onRetry={onRetry} onOpenOptions={onOpenOptions} onRun={onRun} />,
      root,
    ),
  );
}

afterEach(async () => {
  await act(() => render(null, root));
});

describe('ListingCard', () => {
  it('shows the loading state', async () => {
    await show({ status: 'loading' });
    expect(root.querySelector('[role="status"]')?.textContent).toBe("Fripon analyse l'annonce…");
    expect(root.querySelector('[role="status"] svg')).not.toBeNull();
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

  describe('image search', () => {
    const match = (platform: string, n: number, exact: boolean): ImageMatch => ({
      platform,
      url: `https://www.${platform.toLowerCase()}.com/p-${n}`,
      exact,
      price: null,
    });
    const withImage = (overrides: Partial<CheckResult>): CardState => ({
      ...done,
      checks: [
        check('image', { status: 'bad', tag: 'Trouvée sur Shein', ...overrides }),
        ...checks.slice(1),
      ],
    });
    const expand = () =>
      act(() => (root.querySelector('.fripon__toggle') as HTMLButtonElement).click());
    const links = () => [...root.querySelectorAll<HTMLAnchorElement>('.fripon__check a')];

    it('links to the matches, exact ones first, before the Lens link', async () => {
      const matches = [match('Shein', 1, true), match('Temu', 2, false)];
      await show(withImage({ matches }));
      await expand();

      expect(links().map((a) => a.textContent)).toEqual([
        'Voir sur Shein',
        'Photo proche sur Temu',
        'Chercher moi-même sur Google Lens',
      ]);
      const [first, second] = links();
      expect(first?.getAttribute('href')).toBe('https://www.shein.com/p-1');
      expect(second?.getAttribute('href')).toBe('https://www.temu.com/p-2');
      for (const link of links()) {
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      }
    });

    it('puts an exact match first even if it comes later in the list', async () => {
      await show(withImage({ matches: [match('Temu', 2, false), match('Shein', 1, true)] }));
      await expand();
      expect(links()[0]?.textContent).toBe('Voir sur Shein');
    });

    it('shows at most three match links', async () => {
      const matches = [1, 2, 3, 4, 5].map((n) => match('Shein', n, n <= 4));
      await show(withImage({ matches }));
      await expand();
      const hrefs = links().map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual([
        'https://www.shein.com/p-1',
        'https://www.shein.com/p-2',
        'https://www.shein.com/p-3',
        expect.stringContaining('lens.google.com'),
      ]);
    });

    it('shows only the Lens link when nothing was found', async () => {
      await show(withImage({ status: 'ok', tag: 'Introuvable' }));
      await expand();
      expect(links().map((a) => a.textContent)).toEqual(['Chercher moi-même sur Google Lens']);
    });

    it('never links to something that is not http(s)', async () => {
      const bad: ImageMatch = { ...match('Shein', 1, true), url: 'javascript:alert(1)' };
      await show(withImage({ matches: [bad, match('Temu', 2, false)] }));
      await expand();
      const hrefs = links().map((a) => a.getAttribute('href'));
      expect(hrefs.some((href) => href?.startsWith('javascript'))).toBe(false);
      expect(links().map((a) => a.textContent)).toContain('Photo proche sur Temu');
    });

    it('puts match links on the image row only', async () => {
      const state = withImage({ matches: [match('Shein', 1, true)] }) as Extract<
        CardState,
        { status: 'done' }
      >;
      const stray = check('seller', { matches: [match('Shein', 9, true)] });
      await show({ ...state, checks: [state.checks[0] as CheckResult, stray, ...checks.slice(2)] });
      await expand();
      expect(links().filter((a) => a.textContent === 'Voir sur Shein')).toHaveLength(1);
    });

    it('labels a copy "Voir sur" and a lookalike "Photo proche sur"', async () => {
      const matches = [match('Temu', 2, false), match('Shein', 1, true), match('Temu', 3, false)];
      await show(withImage({ matches }));
      await expand();
      expect(links().map((a) => a.textContent)).toEqual([
        'Voir sur Shein',
        'Photo proche sur Temu',
        'Photo proche sur Temu',
        'Chercher moi-même sur Google Lens',
      ]);
    });

    it('shows "Lancer la recherche d\'image" on the run action, and runs the search on click', async () => {
      const run = vi.fn();
      await show(
        withImage({ status: 'off', tag: 'Au clic', action: 'run_image_search' }),
        undefined,
        undefined,
        run,
      );
      await expand();

      const button = root.querySelector('.fripon__check .fripon__action') as HTMLButtonElement;
      expect(button.tagName).toBe('BUTTON');
      expect(button.type).toBe('button');
      expect(button.textContent).toBe("Lancer la recherche d'image");
      await act(() => button.click());
      expect(run).toHaveBeenCalledOnce();
      expect(links().map((a) => a.textContent)).toEqual(['Chercher moi-même sur Google Lens']);
    });

    it('does not open the options page for the run action', async () => {
      const open = vi.fn();
      await show(
        withImage({ status: 'off', action: 'run_image_search' }),
        undefined,
        open,
        vi.fn(),
      );
      await expand();
      await act(() =>
        (root.querySelector('.fripon__check .fripon__action') as HTMLButtonElement).click(),
      );
      expect(open).not.toHaveBeenCalled();
    });

    it('has no run button when nobody handles the click', async () => {
      await show(withImage({ status: 'off', action: 'run_image_search' }), undefined, vi.fn());
      await expand();
      expect(root.querySelector('.fripon__check .fripon__action')).toBeNull();
    });

    it('shows "Vérifier ma clé" on the keys action, and opens the keys section', async () => {
      const open = vi.fn();
      await show(withImage({ status: 'off', action: 'open_keys' }), undefined, open);
      await expand();
      const button = root.querySelector('.fripon__check .fripon__action') as HTMLButtonElement;
      expect(button.textContent).toBe('Vérifier ma clé');
      await act(() => button.click());
      expect(open).toHaveBeenCalledWith('keys');
    });

    it('shows the searching row with its text and no button', async () => {
      await show(
        withImage({ status: 'off', tag: 'En cours', detail: 'Recherche en cours…' }),
        undefined,
        vi.fn(),
        vi.fn(),
      );
      await expand();
      const row = root.querySelector('.fripon__check') as HTMLElement;
      expect(row.textContent).toContain('Recherche en cours…');
      expect(row.querySelector('.fripon__tag--off')?.textContent).toBe('En cours');
      expect(row.querySelector('.fripon__action')).toBeNull();
    });

    describe('the search button on the collapsed card', () => {
      const manual = withImage({ status: 'off', tag: 'Au clic', action: 'run_image_search' });
      const topButtons = () => [
        ...root.querySelectorAll<HTMLButtonElement>('.fripon > .fripon__actions .fripon__action'),
      ];

      it('sits under the verdict lines, before the toggle, and runs the search', async () => {
        const run = vi.fn();
        await show(manual, undefined, undefined, run);

        const buttons = topButtons();
        expect(buttons.map((b) => b.textContent)).toEqual(["Lancer la recherche d'image"]);
        const card = root.querySelector('.fripon') as HTMLElement;
        const order = [...card.children].map((el) => el.className);
        expect(order.indexOf('fripon__actions')).toBeGreaterThan(order.lastIndexOf('fripon__line'));
        expect(order.indexOf('fripon__actions')).toBeLessThan(order.indexOf('fripon__toggle'));
        await act(() => buttons[0]?.click());
        expect(run).toHaveBeenCalledOnce();
      });

      it('hands over to the image row once the checks are expanded: one button at a time', async () => {
        await show(manual, undefined, undefined, vi.fn());
        await expand();
        expect(topButtons()).toHaveLength(0);
        expect(root.querySelectorAll('.fripon__action')).toHaveLength(1);
        expect(root.querySelector('.fripon__check .fripon__action')?.textContent).toBe(
          "Lancer la recherche d'image",
        );
        await act(() => (root.querySelector('.fripon__toggle') as HTMLButtonElement).click());
        expect(topButtons()).toHaveLength(1);
      });

      it('has no button when nobody handles the click', async () => {
        await show(manual);
        expect(topButtons()).toHaveLength(0);
      });

      it('has no button for the other actions, which stay in the expanded rows', async () => {
        await show(withImage({ status: 'off', action: 'open_guide' }), undefined, vi.fn(), vi.fn());
        expect(root.querySelector('.fripon__action')).toBeNull();
        await show(withImage({ matches: [match('Shein', 1, true)] }), undefined, vi.fn(), vi.fn());
        expect(root.querySelector('.fripon__action')).toBeNull();
      });

      it('says "Réessayer la recherche" on a retry, collapsed and expanded', async () => {
        const retry = withImage({
          status: 'off',
          tag: 'Recherche impossible',
          action: 'run_image_search',
          actionLabel: 'Réessayer la recherche',
        });
        const run = vi.fn();
        await show(retry, undefined, undefined, run);
        expect(topButtons().map((b) => b.textContent)).toEqual(['Réessayer la recherche']);
        await act(() => topButtons()[0]?.click());
        expect(run).toHaveBeenCalledOnce();

        await expand();
        expect(root.querySelector('.fripon__check .fripon__action')?.textContent).toBe(
          'Réessayer la recherche',
        );
      });
    });

    it('keeps the checks expanded when the row changes after a search', async () => {
      const run = vi.fn();
      const manual = withImage({ status: 'off', tag: 'Au clic', action: 'run_image_search' });
      await show(manual, undefined, undefined, run);
      await expand();
      await show(withImage({ matches: [match('Shein', 1, true)] }), undefined, undefined, run);
      expect(root.querySelector('.fripon__check')).not.toBeNull();
      expect(links()[0]?.textContent).toBe('Voir sur Shein');
    });
  });

  describe('AI review', () => {
    const withAi = (ai: AiBlock | undefined, rows: CheckResult[] = checks): CardState => ({
      ...done,
      checks: rows,
      ...(ai && { ai }),
    });
    const block = () => root.querySelector('.fripon__ai');
    const topButtons = () => [
      ...root.querySelectorAll<HTMLButtonElement>('.fripon > .fripon__actions .fripon__action'),
    ];
    const aiButtons = () => [
      ...root.querySelectorAll<HTMLButtonElement>('.fripon__ai .fripon__action'),
    ];

    async function expand() {
      await act(() => (root.querySelector('.fripon__toggle') as HTMLButtonElement).click());
    }

    it('has no AI block without an AI state, expanded or not', async () => {
      await show(withAi(undefined));
      await expand();
      expect(block()).toBeNull();
      expect(root.textContent).not.toContain("L'avis de l'IA");
    });

    it('shows the summary and the reminder that it can be wrong, in the expanded card only', async () => {
      await show(withAi({ status: 'done', summary: 'Photo de studio, vue sur Shein.' }));
      expect(block()).toBeNull();
      expect(root.textContent).not.toContain('Photo de studio');

      await expand();
      expect(block()?.querySelector('.fripon__ai-title')?.textContent).toBe("L'avis de l'IA");
      expect(block()?.textContent).toContain('Photo de studio, vue sur Shein.');
      expect(block()?.textContent).toContain('Résumé par Gemini, il peut se tromper.');
    });

    it('puts the block first in the expanded card: before the checks and the prudence note', async () => {
      await show(withAi({ status: 'done', summary: 'Un résumé.' }));
      await expand();
      const children = [...(root.querySelector('#fripon-checks')?.children ?? [])].map(
        (el) => el.className,
      );
      expect(children).toEqual(['fripon__ai', 'fripon__checks', 'fripon__foot']);
      // Right under the verdict lines and the toggle, nothing else in between.
      const card = root.querySelector('.fripon') as HTMLElement;
      const order = [...card.children].map((el) => el.className || el.id);
      expect(order.at(-1)).toBe('fripon-checks');
      expect(order.at(-2)).toBe('fripon__toggle');
    });

    it('shows the summary as plain text, whatever it looks like', async () => {
      await show(withAi({ status: 'done', summary: '<img src=x onerror=alert(1)> Salut' }));
      await expand();
      expect(block()?.querySelector('img')).toBeNull();
      expect(block()?.textContent).toContain('<img src=x onerror=alert(1)> Salut');
    });

    it('says the AI is reading while the review runs, with no note and no button', async () => {
      await show(withAi({ status: 'running' }), undefined, undefined, vi.fn());
      await expand();
      expect(block()?.querySelector('[role="status"]')?.textContent).toBe("L'IA lit l'annonce…");
      expect(block()?.textContent).not.toContain('Résumé par Gemini');
      expect(aiButtons()).toHaveLength(0);
    });

    it('shows a failure as one neutral line', async () => {
      await show(withAi({ status: 'failed', message: "L'IA ne répond pas pour l'instant." }));
      await expand();
      expect(block()?.textContent).toContain("L'IA ne répond pas pour l'instant.");
      expect(block()?.textContent).not.toContain('Résumé par Gemini');
      expect(aiButtons()).toHaveLength(0);
    });

    it('adds the "Vérifier ma clé" button to a key failure, and opens the keys', async () => {
      const open = vi.fn();
      await show(
        withAi({ status: 'failed', message: 'Google refuse ta clé Gemini.', action: 'open_keys' }),
        undefined,
        open,
      );
      await expand();
      expect(aiButtons().map((b) => b.textContent)).toEqual(['Vérifier ma clé']);
      await act(() => aiButtons()[0]?.click());
      expect(open).toHaveBeenCalledWith('keys');
    });

    it('has no key button when nobody handles the click', async () => {
      await show(withAi({ status: 'failed', message: 'Refusée.', action: 'open_keys' }));
      await expand();
      expect(aiButtons()).toHaveLength(0);
    });

    describe('waiting for a click (Au clic)', () => {
      const imageOnly = [
        check('image', { status: 'off', tag: 'Désactivée', action: 'open_guide' }),
        ...checks.slice(1),
      ];
      const imageButton = [
        check('image', { status: 'off', tag: 'Au clic', action: 'run_image_search' }),
        ...checks.slice(1),
      ];

      it('puts "Lancer l\'avis IA" under the verdict lines of the collapsed card, and runs the review', async () => {
        const run = vi.fn();
        await show(withAi({ status: 'waiting' }, imageOnly), undefined, undefined, run);
        expect(topButtons().map((b) => b.textContent)).toEqual(["Lancer l'avis IA"]);
        const card = root.querySelector('.fripon') as HTMLElement;
        const order = [...card.children].map((el) => el.className);
        expect(order.indexOf('fripon__actions')).toBeLessThan(order.indexOf('fripon__toggle'));
        await act(() => topButtons()[0]?.click());
        expect(run).toHaveBeenCalledOnce();
      });

      it('hands over to the AI block once the checks are expanded: one button at a time', async () => {
        const run = vi.fn();
        await show(withAi({ status: 'waiting' }, imageOnly), undefined, undefined, run);
        await expand();
        expect(topButtons()).toHaveLength(0);
        // The image row has its own button (the guide's); the AI one is in the block.
        expect(aiButtons().map((b) => b.textContent)).toEqual(["Lancer l'avis IA"]);
        expect(block()?.querySelector('.fripon__ai-title')?.textContent).toBe("L'avis de l'IA");
        await act(() => aiButtons()[0]?.click());
        expect(run).toHaveBeenCalledOnce();
        await expand();
        expect(topButtons()).toHaveLength(1);
      });

      it('leaves the review to the image search button when the image row has one', async () => {
        const run = vi.fn();
        await show(withAi({ status: 'waiting' }, imageButton), undefined, undefined, run);
        expect(topButtons().map((b) => b.textContent)).toEqual(["Lancer la recherche d'image"]);
        await expand();
        // One button for both, on the image row; no block, no second button.
        expect(block()).toBeNull();
        expect(root.querySelectorAll('.fripon__action')).toHaveLength(1);
        expect(root.querySelector('.fripon__check .fripon__action')?.textContent).toBe(
          "Lancer la recherche d'image",
        );
        await act(() => (root.querySelector('.fripon__action') as HTMLButtonElement).click());
        // The one callback runs both steps: the page decides what the click starts.
        expect(run).toHaveBeenCalledOnce();
      });

      it('has no button and no block when nobody handles the click', async () => {
        await show(withAi({ status: 'waiting' }, imageOnly));
        expect(topButtons()).toHaveLength(0);
        await expand();
        expect(aiButtons()).toHaveLength(0);
        expect(root.querySelectorAll('.fripon__ai .fripon__action')).toHaveLength(0);
      });

      it('shows no waiting button once the review is running or done', async () => {
        const run = vi.fn();
        for (const ai of [
          { status: 'running' },
          { status: 'done', summary: 'Un résumé.' },
        ] as const) {
          await show(withAi(ai, imageOnly), undefined, undefined, run);
          expect(topButtons()).toHaveLength(0);
          await expand();
          expect(aiButtons()).toHaveLength(0);
          await expand();
        }
      });
    });

    it('keeps the checks expanded when the AI block changes', async () => {
      await show(withAi({ status: 'running' }));
      await expand();
      await show(withAi({ status: 'done', summary: 'Le résumé est arrivé.' }));
      expect(root.querySelector('.fripon__check')).not.toBeNull();
      expect(block()?.textContent).toContain('Le résumé est arrivé.');
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
