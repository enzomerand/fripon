import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { recordSpend } from '../../lib/credits';
import { SETTINGS_KEY, loadSettings, saveSettings } from '../../lib/settings';
import { OptionsApp } from './OptionsApp';

// A plausible-looking key (39 characters) made up for the tests.
const KEY = 'AIza' + 'abcdefghijklmnopqrstuvwxyz0123456_-';
const OPTIONS_URL = 'https://fripon.test/options.html';

type HappyWindow = import('happy-dom').Window;

let root: HTMLElement;

const setHash = (hash: string) =>
  (window as unknown as HappyWindow).happyDOM.setURL(`${OPTIONS_URL}${hash}`);

/** Intl uses narrow no-break spaces; compare against plain ones. */
const plain = (text: string | null | undefined) => (text ?? '').replace(/\s/g, ' ');

async function settle(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Counts attempts rather than reading the clock: some tests freeze `Date`. */
async function until(predicate: () => boolean, attempts = 200) {
  for (let i = 0; !predicate(); i++) {
    if (i >= attempts) throw new Error('Timed out waiting for the page');
    await settle(10);
  }
}

async function mount() {
  await act(() => render(<OptionsApp />, root));
  await until(() => root.querySelector('#mode') !== null);
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  root.querySelector(selector) as T | null;

function keyBlock(provider: 'vision' | 'gemini') {
  return $(`.key[data-provider="${provider}"]`) as HTMLElement;
}

function creditRow(provider: 'vision' | 'gemini') {
  return $(`.credit[data-provider="${provider}"]`) as HTMLElement;
}

function button(within: Element, label: string) {
  const found = [...within.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`No "${label}" button`);
  return found as HTMLButtonElement;
}

async function type(input: HTMLInputElement, value: string, commit = false) {
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (commit) input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(element: Element) {
  await act(() => (element as HTMLElement).click());
}

beforeEach(() => {
  fakeBrowser.reset();
  setHash('');
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  render(null, root);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('options page', () => {
  it('has the header, the five sections and the footer', async () => {
    await mount();
    expect($('h1')?.textContent).toContain('Fripon');
    expect($('.header__subtitle')?.textContent).toBe('Réglages');
    for (const id of ['welcome', 'mode', 'keys', 'credits', 'guide']) {
      expect($(`#${id}`), id).not.toBeNull();
    }
    const footer = $('footer') as HTMLElement;
    expect(footer.textContent).toContain(
      "Tes clés restent dans ton navigateur. Fripon n'a aucun serveur.",
    );
    const repo = footer.querySelector('a') as HTMLAnchorElement;
    expect(repo.href).toBe('https://github.com/enzomerand/fripon');
    expect(repo.target).toBe('_blank');
    expect(repo.rel).toBe('noopener noreferrer');
  });

  it('shows nothing but the shell while the settings load, and an alert if they cannot be read', async () => {
    vi.spyOn(browser.storage.local, 'get').mockRejectedValue(new Error('storage'));
    await act(() => render(<OptionsApp />, root));
    await until(() => $('[role="alert"]') !== null);
    expect($('#mode')).toBeNull();
  });
});

describe('welcome banner', () => {
  it('is shown, in exactly three sentences, when there is no key', async () => {
    await mount();
    const text = $('.welcome__text')?.textContent ?? '';
    expect(text.split(/(?<=\.)\s+/)).toHaveLength(3);
    expect(text).toContain('Fripon vérifie chaque annonce Vinted');
    expect(button($('#welcome') as HTMLElement, 'Suivre le guide')).toBeTruthy();
  });

  it('is hidden once a key is saved', async () => {
    await saveSettings({ keys: { gemini: KEY } });
    await mount();
    expect($('#welcome')).toBeNull();
  });

  it('is shown on #welcome even with a key', async () => {
    setHash('#welcome');
    await saveSettings({ keys: { gemini: KEY } });
    await mount();
    expect($('#welcome')).not.toBeNull();
  });

  it('can be dismissed', async () => {
    await mount();
    await click(button($('#welcome') as HTMLElement, 'Plus tard'));
    expect($('#welcome')).toBeNull();
  });

  it('opens the guide and scrolls to it', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await mount();
    expect([...document.querySelectorAll('details')].some((d) => d.open)).toBe(false);

    await click(button($('#welcome') as HTMLElement, 'Suivre le guide'));
    expect([...document.querySelectorAll('details')].every((d) => d.open)).toBe(true);
    expect(location.hash).toBe('#guide');
    expect(scroll).toHaveBeenCalled();
    expect(scroll.mock.contexts.at(-1)).toBe($('#guide'));
  });
});

describe('mode', () => {
  it('starts on automatic', async () => {
    await mount();
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ['auto', true],
      ['click', false],
    ]);
    expect($('#mode')?.textContent).toContain("Chaque annonce est analysée dès que tu l'ouvres.");
    expect($('#mode')?.textContent).toContain(
      "Les vérifications gratuites restent automatiques ; la recherche d'image et l'IA attendent ton clic pour économiser tes crédits.",
    );
  });

  it('saves the choice as soon as it is made', async () => {
    await mount();
    await click($('input[name="mode"][value="click"]') as HTMLInputElement);
    await until(
      () => document.querySelector<HTMLInputElement>('input[value="click"]')?.checked === true,
    );

    expect((await loadSettings()).mode).toBe('click');
    expect(
      ((await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as { mode: string }).mode,
    ).toBe('click');
  });

  it('shows the saved mode', async () => {
    await saveSettings({ mode: 'click' });
    await mount();
    expect($<HTMLInputElement>('input[name="mode"][value="click"]')?.checked).toBe(true);
  });
});

describe('keys', () => {
  it('has a block per provider with the expected titles', async () => {
    await mount();
    expect(keyBlock('vision').querySelector('h3')?.textContent).toBe(
      "Recherche d'image — Google Cloud Vision",
    );
    expect(keyBlock('gemini').querySelector('h3')?.textContent).toBe('Analyse IA — Gemini');
  });

  it('saves a key, shows it masked and enables nothing else by accident', async () => {
    await mount();
    const block = keyBlock('gemini');
    const input = block.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(button(block, 'Enregistrer').disabled).toBe(true);

    await type(input, `  ${KEY}  `);
    expect(block.textContent).not.toContain('ne ressemble pas');
    await click(button(block, 'Enregistrer'));
    await until(() => block.textContent?.includes('Clé enregistrée :') === true);

    expect((await loadSettings()).keys).toEqual({ vision: '', gemini: KEY });
    expect(block.querySelector('code')?.textContent).toBe(`AIza••••••${KEY.slice(-4)}`);
    expect(button(block, 'Enregistrer').disabled).toBe(true);
    // The welcome banner goes away with the first key.
    await until(() => $('#welcome') === null);
  });

  it('shows and hides the key', async () => {
    await saveSettings({ keys: { vision: KEY } });
    await mount();
    const block = keyBlock('vision');
    expect(block.querySelector('input')?.type).toBe('password');
    await click(button(block, 'Afficher'));
    expect(block.querySelector('input')?.type).toBe('text');
    expect(block.querySelector('input')?.value).toBe(KEY);
    await click(button(block, 'Masquer'));
    expect(block.querySelector('input')?.type).toBe('password');
  });

  it('warns, without blocking, about a key that does not look like a Google key', async () => {
    await mount();
    const block = keyBlock('vision');
    await type(block.querySelector('input') as HTMLInputElement, 'not-a-google-key');
    expect(block.textContent).toContain('ne ressemble pas à une clé Google');
    expect(button(block, 'Enregistrer').disabled).toBe(false);
    await click(button(block, 'Enregistrer'));
    await until(() => block.textContent?.includes('Clé enregistrée.') === true);
    expect((await loadSettings()).keys.vision).toBe('not-a-google-key');
  });

  it('saves, then tests the stored key without ever sending the key in the message', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ ok: true } as never);
    await mount();
    const block = keyBlock('vision');
    await type(block.querySelector('input') as HTMLInputElement, KEY);
    await click(button(block, 'Tester'));
    await until(() => block.textContent?.includes('✓ Clé valide') === true);

    expect((await loadSettings()).keys.vision).toBe(KEY);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: 'testKey', provider: 'vision' });
    expect(JSON.stringify(send.mock.calls)).not.toContain(KEY);
  });

  it.each([
    ['invalid', 'Google refuse cette clé'],
    ['disabled', "L'API n'est pas activée sur ce projet"],
    ['billing', "La facturation n'est pas activée sur ce projet"],
    ['quota', 'limite de cette clé est atteinte'],
    ['network', 'Impossible de joindre Google'],
  ])('explains a %s failure', async (reason, expected) => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ ok: false, reason } as never);
    await saveSettings({ keys: { gemini: KEY } });
    await mount();
    const block = keyBlock('gemini');
    await click(button(block, 'Tester'));
    await until(() => block.querySelector('.status--bad') !== null);
    expect(block.querySelector('.status--bad')?.textContent).toContain(expected);
    expect(block.textContent).not.toContain('✓');
  });

  it('says so when the test cannot be run at all', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('no background'));
    await saveSettings({ keys: { gemini: KEY } });
    await mount();
    const block = keyBlock('gemini');
    await click(button(block, 'Tester'));
    await until(() => block.querySelector('.status--bad') !== null);
    expect(block.querySelector('.status--bad')?.textContent).toContain("n'a pas pu lancer le test");
  });

  it('asks for a key before testing an empty field', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage');
    await mount();
    const block = keyBlock('gemini');
    await click(button(block, 'Tester'));
    expect(block.textContent).toContain("Colle d'abord ta clé");
    expect(send).not.toHaveBeenCalled();
  });

  it('erases a saved key', async () => {
    await saveSettings({ keys: { vision: KEY, gemini: KEY } });
    await mount();
    const block = keyBlock('vision');
    await click(button(block, 'Effacer'));
    await until(() => block.querySelector('code') === null);

    expect((await loadSettings()).keys).toEqual({ vision: '', gemini: KEY });
    expect((block.querySelector('input') as HTMLInputElement).value).toBe('');
    expect(button(block, 'Effacer').disabled).toBe(true);
  });
});

describe('credits', () => {
  const now = new Date(2026, 9, 20, 14, 0);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  });

  it('starts at zero with the free-tier caps and the reset dates', async () => {
    await mount();
    expect(plain(creditRow('vision').querySelector('.credit__count')?.textContent)).toBe(
      "Recherche d'image : 0 / 1 000 ce mois-ci",
    );
    expect(plain(creditRow('gemini').querySelector('.credit__count')?.textContent)).toBe(
      "Analyse IA : 0 / 20 aujourd'hui",
    );
    expect(creditRow('vision').textContent).toContain('Remis à zéro le 1er novembre');
    expect(creditRow('gemini').textContent).toContain('Remis à zéro demain');
    expect(creditRow('vision').querySelector('[role="progressbar"]')).not.toBeNull();
    expect($('#credits')?.textContent).toContain('Le compteur est local');
  });

  it('shows the spent credits with a progress bar', async () => {
    await recordSpend('vision', 12, now);
    await mount();
    const row = creditRow('vision');
    expect(plain(row.querySelector('.credit__count')?.textContent)).toBe(
      "Recherche d'image : 12 / 1 000 ce mois-ci",
    );
    const bar = row.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.getAttribute('aria-valuenow')).toBe('12');
    expect(bar.getAttribute('aria-valuemax')).toBe('1000');
    expect(bar.className).toContain('meter--ok');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('1%');
  });

  it('turns orange at 80 % and red at the cap', async () => {
    await recordSpend('gemini', 16, now);
    await mount();
    const bar = () => creditRow('gemini').querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar().className).toContain('meter--warning');
    expect(creditRow('gemini').textContent).toContain('plus de 80 % de ton plafond');

    await act(async () => {
      await recordSpend('gemini', 4, now);
    });
    await until(() => bar().className.includes('meter--reached'));
    expect(creditRow('gemini').textContent).toContain('Plafond atteint');
    expect(bar().getAttribute('aria-valuenow')).toBe('20');
  });

  it('follows the counters live, without a reload', async () => {
    await mount();
    await act(async () => {
      await recordSpend('vision', 5, now);
    });
    await until(() => plain(creditRow('vision').textContent).includes('5 / 1 000'));
  });

  it('saves a new cap when the number is committed', async () => {
    await mount();
    const input = creditRow('vision').querySelector('input[type="number"]') as HTMLInputElement;
    await type(input, '500', true);
    await until(() => plain(creditRow('vision').textContent).includes('0 / 500'));
    expect((await loadSettings()).caps.vision).toBe(500);
    // Below the free tier: nothing to warn about.
    expect(creditRow('vision').querySelector('.callout')).toBeNull();
  });

  it('refuses a cap that is not a whole number of at least 1', async () => {
    await mount();
    const input = creditRow('gemini').querySelector('input[type="number"]') as HTMLInputElement;
    for (const bad of ['0', '2.5', '']) {
      await type(input, bad, true);
      expect(creditRow('gemini').textContent).toContain('nombre entier supérieur ou égal à 1');
    }
    expect((await loadSettings()).caps.gemini).toBe(20);
  });

  it('warns about billing above the free tier', async () => {
    await mount();
    const input = creditRow('vision').querySelector('input[type="number"]') as HTMLInputElement;
    await type(input, '5000', true);
    await until(() => creditRow('vision').querySelector('.callout') !== null);
    expect(creditRow('vision').textContent).toContain(
      "Au-delà de l'offre gratuite, Google te facture la recherche d'image (environ 3,50 $ les 1 000).",
    );
  });

  it('removes the cap, with the warning, and restores the default when unchecked', async () => {
    await recordSpend('gemini', 30, now);
    await mount();
    const row = () => creditRow('gemini');
    const checkbox = () => row().querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox().checked).toBe(false);
    expect(row().querySelector('.callout')).toBeNull();

    await click(checkbox());
    await until(() => row().querySelector('.callout') !== null);
    expect((await loadSettings()).caps.gemini).toBeNull();
    expect(row().textContent).toContain(
      "Si ton projet Gemini a la facturation activée, Google te facture au-delà de l'offre gratuite.",
    );
    expect(plain(row().querySelector('.credit__count')?.textContent)).toBe(
      "Analyse IA : 30 aujourd'hui (sans plafond)",
    );
    expect(row().querySelector('[role="progressbar"]')).toBeNull();
    expect(row().querySelector<HTMLInputElement>('input[type="number"]')?.disabled).toBe(true);
    expect(checkbox().checked).toBe(true);

    await click(checkbox());
    await until(() => row().querySelector('.callout') === null);
    expect((await loadSettings()).caps.gemini).toBe(20);
  });
});

describe('guide', () => {
  it('is folded by default, one block per provider, Gemini first', async () => {
    await mount();
    const details = [...document.querySelectorAll('details')];
    expect(details).toHaveLength(2);
    expect(details.map((d) => d.open)).toEqual([false, false]);
    expect(details[0]?.querySelector('summary')?.textContent).toContain('Gemini');
    expect(details[1]?.querySelector('summary')?.textContent).toContain('Vision');
  });

  it('is open when the page is opened on #guide, and scrolled to', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    setHash('#guide');
    await mount();
    expect([...document.querySelectorAll('details')].map((d) => d.open)).toEqual([true, true]);
    expect(scroll.mock.contexts.at(-1)).toBe($('#guide'));
  });

  it('scrolls to any section named by the hash', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    setHash('#credits');
    await mount();
    expect(scroll.mock.contexts.at(-1)).toBe($('#credits'));
  });

  it('links to the Google pages, each opening in a new tab', async () => {
    await mount();
    const links = [...($('#guide') as HTMLElement).querySelectorAll('a')];
    expect(links.map((a) => a.href)).toEqual([
      'https://aistudio.google.com/apikey',
      'https://console.cloud.google.com/projectcreate',
      'https://console.cloud.google.com/billing',
      'https://console.cloud.google.com/apis/library/vision.googleapis.com',
      'https://console.cloud.google.com/apis/credentials',
    ]);
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
    }
  });

  it('says that a project with billing turns Gemini paid, and that Vision needs a card', async () => {
    await mount();
    const guide = $('#guide')?.textContent ?? '';
    expect(guide).toContain('projet Google différent pour Gemini et pour Vision');
    expect(guide).toContain('carte bancaire');
    expect(guide).toContain('Fripon Vision');
    expect(guide).toContain('AIza');
    expect(guide).toContain('Create API key');
    expect(guide).toContain('Cloud Vision API');
  });
});
