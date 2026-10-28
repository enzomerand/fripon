import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { CLOUD_ORIGIN } from '../../lib/cloud/config';
import { clearSession, expireSession, saveSession, saveStatusFor } from '../../lib/cloud/session';
import type { CloudUsage } from '../../lib/cloud/types';
import { PLAN_USAGE, TRIAL_USAGE } from '../../lib/cloud/test-helpers';
import { saveSettings } from '../../lib/settings';
import { CLOUD_PRIVACY } from './CloudSection';
import { OptionsApp } from './OptionsApp';

type Message = { type: string; [key: string]: unknown };
type Answers = Record<string, (message: Message) => unknown>;

let root: HTMLElement;

async function settle(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function until(predicate: () => boolean, attempts = 200) {
  for (let i = 0; !predicate(); i++) {
    if (i >= attempts) throw new Error('Timed out waiting for the page');
    await settle(10);
  }
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  root.querySelector(selector) as T | null;
const cloud = () => $('#cloud') as HTMLElement;
const text = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

function button(label: string, within: Element = cloud()) {
  const found = [...within.querySelectorAll('button')].find((b) => b.textContent === label);
  return found as HTMLButtonElement | undefined;
}

async function click(element: Element | undefined) {
  if (!element) throw new Error('No such button');
  await act(() => (element as HTMLElement).click());
}

async function type(input: HTMLInputElement, value: string) {
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Submits the form the way Enter would: this page uses real forms. */
async function submit(form: Element | null) {
  await act(() => {
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** Answers the background's messages by type; the ones not listed answer nothing. */
function background(answers: Answers) {
  const seen: Message[] = [];
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: Message) => {
    seen.push(message);
    return Promise.resolve(answers[message.type]?.(message));
  }) as never);
  return { seen, of: (type: string) => seen.filter((m) => m.type === type) };
}

async function signIn(usage: CloudUsage | null, subscription = null as unknown) {
  await saveSession({ token: 'tok-1', email: 'moi@exemple.fr' });
  await saveStatusFor('tok-1', {
    email: 'moi@exemple.fr',
    usage,
    subscription: subscription as never,
    checkedAt: Date.now(),
  });
}

async function mount() {
  await act(() => render(<OptionsApp />, root));
  await until(() => $('#cloud') !== null);
}

beforeEach(() => {
  fakeBrowser.reset();
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  render(null, root);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the subscription section', () => {
  it('comes right after the mode, with its own title', async () => {
    background({});
    await mount();
    const ids = [...root.querySelectorAll('section.card')].map((s) => s.id);
    expect(ids.slice(0, 3)).toEqual(['mode', 'cloud', 'keys']);
    expect(text($('#cloud-title'))).toBe('Abonnement Fripon');
  });

  it('says what is sent, kept and shared, and that the account can be deleted, in both states', async () => {
    background({});
    await mount();
    const privacy = () => text($('.cloud__privacy'));
    const paragraphs = () =>
      [...root.querySelectorAll('.cloud__privacy p')].map((paragraph) => text(paragraph));
    expect(paragraphs()).toEqual(CLOUD_PRIVACY);
    for (const part of [
      "l'adresse de la photo",
      'le titre',
      'la description',
      'le prix',
      'les indices calculés par Fripon',
      'serveur de Fripon',
      'clés payantes',
      "Google (Cloud Vision) pour la recherche d'image",
      "Anthropic (Claude) pour l'avis de l'IA",
      'Google ne les utilise pas pour améliorer ses produits',
      "Anthropic ne s'en sert pas pour entraîner ses modèles",
      "transfert de données hors de l'Union européenne",
      'ton adresse e-mail',
      "l'état de ton abonnement",
      '2 mois au plus',
      'gardés 35 jours',
      "ceux d'un avis de l'IA 7 jours",
      'Ton adresse IP, tronquée, reste 7 jours dans les journaux du serveur web',
      "l'application n'en garde qu'une empreinte (hash) pendant 24 h, pour limiter les abus",
      'Une empreinte de ton adresse e-mail est gardée 12 mois',
      "pour qu'un essai gratuit ne serve qu'une fois",
      "Google (la recherche d'image), Anthropic (l'avis de l'IA)",
      'Stripe (le paiement)',
      "service d'envoi d'e-mails",
      'un hébergeur',
      'supprimer ton compte et son historique depuis cette page',
    ]) {
      expect(privacy()).toContain(part);
    }
    // The claim that IP addresses are only ever kept hashed was false (the web server logs them truncated).
    expect(privacy()).not.toContain("ne sont gardées que sous forme d'empreinte");
    // No e-mail provider, no host, no country: none of them is decided.
    expect(privacy()).not.toMatch(
      /resend|postmark|mailgun|sendgrid|brevo|scaleway|ovh|hetzner|aws|vercel|france|allemagne|irlande|états-unis/i,
    );
    render(null, root);
    await signIn(TRIAL_USAGE);
    await mount();
    expect(paragraphs()).toEqual(CLOUD_PRIVACY);
  });

  it('links to the terms of sale and the privacy policy of the server, each in a new tab, in both states', async () => {
    const links = () => [...cloud().querySelectorAll('.cloud__legal a')] as HTMLAnchorElement[];
    const check = () => {
      expect(links().map((a) => [text(a), a.href])).toEqual([
        ['Conditions générales de vente', `${CLOUD_ORIGIN}/cgv`],
        ['Politique de confidentialité', `${CLOUD_ORIGIN}/confidentialite`],
      ]);
      for (const link of links()) {
        expect(link.target).toBe('_blank');
        expect(link.rel).toBe('noopener noreferrer');
      }
      // Under the privacy text, and outside it: the paragraphs stay the shared constant.
      const privacy = $('.cloud__privacy') as HTMLElement;
      expect(privacy.contains(links()[0] as HTMLElement)).toBe(false);
      expect(
        privacy.compareDocumentPosition($('.cloud__legal') as HTMLElement) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    };

    background({});
    await mount();
    check();
    render(null, root);
    await signIn(TRIAL_USAGE);
    await mount();
    check();
  });

  it('says the same in the guide', async () => {
    background({});
    await mount();
    const paragraphs = [...root.querySelectorAll('#guide .guide__privacy p')].map(text);
    expect(paragraphs).toEqual(CLOUD_PRIVACY);
  });
});

describe('signed out', () => {
  it('pitches the subscription and asks for an e-mail address', async () => {
    background({});
    await mount();
    expect(text(cloud())).toContain(
      "Pas envie de créer des clés Google ? Abonne-toi : Fripon s'occupe de la recherche d'image et de l'avis IA. 15 analyses offertes pour essayer.",
    );
    expect($('#cloud-email')).not.toBeNull();
    expect(button('Recevoir un code')).toBeDefined();
    expect($('#cloud-code')).toBeNull();
    expect(button('Me déconnecter')).toBeUndefined();
  });

  it('sends the address, then asks for the code that came by e-mail', async () => {
    const bg = background({ cloudRequestCode: () => ({ ok: true }) });
    await mount();
    await type($('#cloud-email') as HTMLInputElement, ' moi@exemple.fr ');
    await submit($('#cloud form'));
    await until(() => $('#cloud-code') !== null);
    expect(bg.of('cloudRequestCode')).toEqual([
      { type: 'cloudRequestCode', email: 'moi@exemple.fr' },
    ]);
    expect(text(cloud())).toContain(
      "Un code à 6 chiffres vient d'être envoyé à moi@exemple.fr. Il est valable 10 minutes.",
    );
    expect(button('Me connecter')).toBeDefined();
    expect(button('Recevoir un code')).toBeUndefined();
  });

  it('signs in with the six digits, spaces ignored, and then shows the account', async () => {
    const bg = background({
      cloudRequestCode: () => ({ ok: true }),
      cloudVerify: async () => {
        // What the background does: store the session, and the page follows the status.
        await saveSession({ token: 'tok-1', email: 'moi@exemple.fr' });
        return { ok: true };
      },
    });
    await mount();
    await type($('#cloud-email') as HTMLInputElement, 'moi@exemple.fr');
    await submit($('#cloud form'));
    await until(() => $('#cloud-code') !== null);

    await type($('#cloud-code') as HTMLInputElement, '123 456');
    await submit($('#cloud form'));
    await until(() => button('Me déconnecter') !== undefined);
    expect(bg.of('cloudVerify')).toEqual([
      { type: 'cloudVerify', email: 'moi@exemple.fr', code: '123456' },
    ]);
    expect(text(cloud())).toContain('moi@exemple.fr');
    expect($('#cloud-email')).toBeNull();
  });

  it('lets the user ask for the code again, or change the address', async () => {
    const bg = background({ cloudRequestCode: () => ({ ok: true }) });
    await mount();
    await type($('#cloud-email') as HTMLInputElement, 'moi@exemple.fr');
    await submit($('#cloud form'));
    await until(() => $('#cloud-code') !== null);

    await click(button('Renvoyer le code'));
    await until(() => bg.of('cloudRequestCode').length === 2);
    await until(() => button("Changer d'adresse")?.disabled === false);
    await click(button("Changer d'adresse"));
    expect($('#cloud-email')).not.toBeNull();
    expect($('#cloud-code')).toBeNull();
  });

  it('refuses a blank address and an incomplete code without sending anything', async () => {
    const bg = background({ cloudRequestCode: () => ({ ok: true }) });
    await mount();
    await type($('#cloud-email') as HTMLInputElement, '   ');
    await submit($('#cloud form'));
    expect(text($('#cloud .status'))).toBe("Cette adresse e-mail n'a pas l'air valide.");
    expect(bg.seen).toEqual([]);

    await type($('#cloud-email') as HTMLInputElement, 'moi@exemple.fr');
    await submit($('#cloud form'));
    await until(() => $('#cloud-code') !== null);
    await type($('#cloud-code') as HTMLInputElement, '12 34');
    await submit($('#cloud form'));
    expect(text($('#cloud .status'))).toContain('Code invalide ou expiré');
    expect(bg.of('cloudVerify')).toEqual([]);
  });

  it.each([
    ['invalid_email', "Cette adresse e-mail n'a pas l'air valide."],
    ['rate_limited', "Trop d'essais. Réessaie dans quelques minutes."],
    ['mail_unavailable', 'Envoi impossible pour le moment. Réessaie dans quelques minutes.'],
    ['network', 'Impossible de joindre Fripon. Vérifie ta connexion, puis réessaie.'],
  ])('says in plain French why a code could not be sent (%s)', async (reason, expected) => {
    background({ cloudRequestCode: () => ({ ok: false, reason }) });
    await mount();
    await type($('#cloud-email') as HTMLInputElement, 'moi@exemple.fr');
    await submit($('#cloud form'));
    await until(() => text($('#cloud .status')) === expected);
    // Still on the address: nothing was sent, so there is no code to type.
    expect($('#cloud-code')).toBeNull();
  });

  it.each([
    [
      'invalid_code',
      'Code invalide ou expiré. Vérifie les 6 chiffres, ou demande un nouveau code.',
    ],
    ['rate_limited', "Trop d'essais. Réessaie dans quelques minutes."],
    ['network', 'Impossible de joindre Fripon. Vérifie ta connexion, puis réessaie.'],
  ])('says in plain French why a code was refused (%s)', async (reason, expected) => {
    background({
      cloudRequestCode: () => ({ ok: true }),
      cloudVerify: () => ({ ok: false, reason }),
    });
    await mount();
    await type($('#cloud-email') as HTMLInputElement, 'moi@exemple.fr');
    await submit($('#cloud form'));
    await until(() => $('#cloud-code') !== null);
    await type($('#cloud-code') as HTMLInputElement, '123456');
    await submit($('#cloud form'));
    await until(() => text($('#cloud .status')) === expected);
    expect(button('Me déconnecter')).toBeUndefined();
  });

  it('says so when the background does not answer', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('no background'));
    await mount();
    await type($('#cloud-email') as HTMLInputElement, 'moi@exemple.fr');
    await submit($('#cloud form'));
    await until(() => text($('#cloud .status')).includes("n'a pas pu lancer la demande"));
  });
});

describe('an expired session', () => {
  async function expired() {
    await saveSession({ token: 'tok-1', email: 'moi@exemple.fr' });
    await expireSession('tok-1');
  }

  it('says so, with the address already in the sign-in form', async () => {
    await expired();
    background({});
    await mount();
    expect(text(cloud())).toContain('Ta session a expiré. Reconnecte-toi pour continuer.');
    expect(($('#cloud-email') as HTMLInputElement).value).toBe('moi@exemple.fr');
    expect(button('Recevoir un code')).toBeDefined();
    expect(button('Me déconnecter')).toBeUndefined();
    // A subscriber is not sent to a Google key guide.
    expect($('#welcome')).toBeNull();
  });

  it('says nothing of the kind to someone who was never signed in', async () => {
    background({});
    await mount();
    expect(text(cloud())).not.toContain('expiré');
    expect(($('#cloud-email') as HTMLInputElement).value).toBe('');
  });

  it('asks for the code of the same address, and the notice goes once signed in again', async () => {
    await expired();
    const bg = background({
      cloudRequestCode: () => ({ ok: true }),
      cloudVerify: async () => {
        await saveSession({ token: 'tok-2', email: 'moi@exemple.fr' });
        return { ok: true };
      },
    });
    await mount();
    await submit($('#cloud form'));
    await until(() => $('#cloud-code') !== null);
    expect(bg.of('cloudRequestCode')).toEqual([
      { type: 'cloudRequestCode', email: 'moi@exemple.fr' },
    ]);
    await type($('#cloud-code') as HTMLInputElement, '123456');
    await submit($('#cloud form'));
    await until(() => button('Me déconnecter') !== undefined);
    expect(text(cloud())).not.toContain('expiré');
  });

  it('shows up by itself when the session ends while the page is open', async () => {
    await saveSession({ token: 'tok-1', email: 'moi@exemple.fr' });
    await saveStatusFor('tok-1', {
      email: 'moi@exemple.fr',
      usage: TRIAL_USAGE,
      subscription: null,
      checkedAt: Date.now(),
    });
    background({});
    await mount();
    expect(button('Me déconnecter')).toBeDefined();
    await act(async () => {
      await expireSession('tok-1');
    });
    await until(() => $('#cloud-email') !== null);
    expect(text(cloud())).toContain('Ta session a expiré. Reconnecte-toi pour continuer.');
    expect(($('#cloud-email') as HTMLInputElement).value).toBe('moi@exemple.fr');
  });
});

describe('signed in', () => {
  it('shows the address, the trial and the three offers, and asks for a fresh reading', async () => {
    await signIn(TRIAL_USAGE);
    const bg = background({});
    await mount();
    await until(() => bg.of('cloudStatus').length > 0);
    expect(text(cloud())).toContain('Connecté : moi@exemple.fr');
    expect(text($('[data-testid="plan"]'))).toBe('Essai : 10 analyses restantes');
    expect(button('Essentiel — 2,99 €/mois')).toBeDefined();
    expect(button('Essentiel — 29,99 €/an')).toBeDefined();
    expect(button('Revendeur — 6,99 €/mois')).toBeDefined();
    expect(button('Gérer mon abonnement')).toBeUndefined();
    expect(button('Me déconnecter')).toBeDefined();
    expect(text(cloud())).toContain(
      "1 analyse = 1 annonce analysée (recherche d'image + avis de l'IA). Revoir la même annonce dans le mois ne compte pas.",
    );
    expect($('#cloud-email')).toBeNull();
  });

  it('says "1 analyse restante" in the singular', async () => {
    await signIn({ ...TRIAL_USAGE, trialLeft: 1 });
    background({});
    await mount();
    expect(text($('[data-testid="plan"]'))).toBe('Essai : 1 analyse restante');
  });

  it('shows the plan and the two counters, and only the button to manage it', async () => {
    await signIn(PLAN_USAGE, { status: 'active', periodEnd: 1_800_000_000_000 });
    background({});
    await mount();
    expect(text($('[data-testid="plan"]'))).toBe('Essentiel');
    expect(text(cloud())).toContain('12 / 300 ce mois-ci');
    expect(text(cloud())).toContain("3 / 40 aujourd'hui");
    const bars = [...root.querySelectorAll('#cloud [role="progressbar"]')];
    expect(bars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['12', '3']);
    expect(bars.map((bar) => bar.getAttribute('aria-valuemax'))).toEqual(['300', '40']);
    expect(button('Gérer mon abonnement')).toBeDefined();
    expect(button('Essentiel — 2,99 €/mois')).toBeUndefined();
  });

  it('names the Revendeur plan, and a plan used up shows its bar full', async () => {
    await signIn({
      ...PLAN_USAGE,
      plan: 'revendeur',
      month: { used: 1000, cap: 1000 },
      day: { used: 5, cap: 100 },
    });
    background({});
    await mount();
    expect(text($('[data-testid="plan"]'))).toBe('Revendeur');
    expect($('#cloud .meter--reached')).not.toBeNull();
  });

  it('says there is no subscription, and that the free analyses are used up', async () => {
    await signIn({ ...TRIAL_USAGE, kind: 'none', trialLeft: 0 });
    background({});
    await mount();
    expect(text($('[data-testid="plan"]'))).toBe('Aucun abonnement');
    expect(text(cloud())).toContain('Tes analyses offertes sont utilisées.');
    expect(button('Revendeur — 6,99 €/mois')).toBeDefined();
  });

  it('warns about a payment that failed', async () => {
    await signIn(PLAN_USAGE, { status: 'past_due', periodEnd: null });
    background({});
    await mount();
    expect(text(cloud())).toContain("Ton dernier paiement n'a pas abouti");
  });

  it('shows an account that was not read yet without inventing figures', async () => {
    await signIn(null);
    background({});
    await mount();
    expect(text($('[data-testid="plan"]'))).toBe('Abonnement pas encore lu');
    expect($('#cloud [role="progressbar"]')).toBeNull();
  });

  it('asks for a subscription page of the chosen price, and says it opens in a new tab', async () => {
    await signIn(TRIAL_USAGE);
    const bg = background({ cloudCheckout: () => ({ ok: true }) });
    await mount();
    await click(button('Essentiel — 29,99 €/an'));
    await until(() => bg.of('cloudCheckout').length === 1);
    expect(bg.of('cloudCheckout')).toEqual([{ type: 'cloudCheckout', price: 'essentiel_yearly' }]);
    await until(() => text($('#cloud .status')).includes('nouvel onglet'));

    await click(button('Revendeur — 6,99 €/mois'));
    await until(() => bg.of('cloudCheckout').length === 2);
    expect(bg.of('cloudCheckout')[1]).toEqual({
      type: 'cloudCheckout',
      price: 'revendeur_monthly',
    });
  });

  it('opens the portal to manage the subscription', async () => {
    await signIn(PLAN_USAGE, { status: 'active', periodEnd: null });
    const bg = background({ cloudPortal: () => ({ ok: true }) });
    await mount();
    await click(button('Gérer mon abonnement'));
    await until(() => bg.of('cloudPortal').length === 1);
    await until(() => text($('#cloud .status')).includes('nouvel onglet'));
  });

  it.each([
    ['signed_out', 'Ta session a expiré : reconnecte-toi.'],
    ['no_customer', 'Aucun abonnement à gérer pour ce compte.'],
    ['rate_limited', "Trop d'essais. Réessaie dans quelques minutes."],
    ['unavailable', "Impossible d'ouvrir la page de paiement. Réessaie dans un instant."],
    ['network', 'Impossible de joindre Fripon. Vérifie ta connexion, puis réessaie.'],
  ])('says in plain French why a Stripe page did not open (%s)', async (reason, expected) => {
    await signIn(PLAN_USAGE, { status: 'active', periodEnd: null });
    background({ cloudPortal: () => ({ ok: false, reason }) });
    await mount();
    await click(button('Gérer mon abonnement'));
    await until(() => text($('#cloud .status')) === expected);
  });

  it('signs out, and the page goes back to the sign-in form', async () => {
    await signIn(TRIAL_USAGE);
    const bg = background({
      cloudSignOut: async () => {
        await clearSession();
      },
    });
    await mount();
    await click(button('Me déconnecter'));
    await until(() => $('#cloud-email') !== null);
    expect(bg.of('cloudSignOut')).toHaveLength(1);
    expect(button('Me déconnecter')).toBeUndefined();
  });

  describe('deleting the account', () => {
    const CONFIRM =
      "Supprimer définitivement ton compte Fripon et ton historique d'analyses ? Tes factures restent chez Stripe.";

    it('is a discreet button that asks once more before doing anything', async () => {
      await signIn(TRIAL_USAGE);
      const bg = background({});
      await mount();
      expect(text(cloud())).not.toContain(CONFIRM);
      await click(button('Supprimer mon compte'));
      expect(text(cloud())).toContain(CONFIRM);
      expect(button('Oui, supprimer')).toBeDefined();
      expect(bg.of('cloudDeleteAccount')).toHaveLength(0);
      // The safe answer has the keyboard.
      expect(document.activeElement).toBe(button('Annuler'));
    });

    it('changes nothing on "Annuler", and gives the keyboard back to the button', async () => {
      await signIn(TRIAL_USAGE);
      const bg = background({});
      await mount();
      await click(button('Supprimer mon compte'));
      await click(button('Annuler'));
      expect(text(cloud())).not.toContain(CONFIRM);
      expect(button('Oui, supprimer')).toBeUndefined();
      expect(document.activeElement).toBe(button('Supprimer mon compte'));
      expect(bg.of('cloudDeleteAccount')).toHaveLength(0);
    });

    it('deletes after the confirmation, and goes back to the sign-in form saying so', async () => {
      await signIn(TRIAL_USAGE);
      const bg = background({
        cloudDeleteAccount: async () => {
          // What the background does on a 204: the session is gone here too.
          await clearSession();
          return { ok: true };
        },
      });
      await mount();
      await click(button('Supprimer mon compte'));
      await click(button('Oui, supprimer'));
      await until(() => $('#cloud-email') !== null);
      expect(bg.of('cloudDeleteAccount')).toHaveLength(1);
      expect(text(cloud())).toContain(
        "Ton compte Fripon et l'historique de tes analyses ont été supprimés.",
      );
      // Deleted, not expired.
      expect(text(cloud())).not.toContain('Ta session a expiré');
      expect(($('#cloud-email') as HTMLInputElement).value).toBe('');
    });

    it('does not say "supprimés" again after a new sign-in and a sign-out', async () => {
      await signIn(TRIAL_USAGE);
      background({
        cloudDeleteAccount: async () => {
          await clearSession();
          return { ok: true };
        },
        cloudSignOut: async () => {
          await clearSession();
        },
      });
      await mount();
      await click(button('Supprimer mon compte'));
      await click(button('Oui, supprimer'));
      await until(() => $('#cloud-email') !== null);
      expect(text(cloud())).toContain('ont été supprimés');

      // Signs in again (a new account), then out.
      await signIn(TRIAL_USAGE);
      await until(() => button('Me déconnecter') !== undefined);
      expect(text(cloud())).not.toContain('ont été supprimés');
      await click(button('Me déconnecter'));
      await until(() => $('#cloud-email') !== null);

      expect(text(cloud())).not.toContain('ont été supprimés');
    });

    it('says to end the subscription first when the server refuses (409), and stays signed in', async () => {
      await signIn(PLAN_USAGE, { status: 'active', periodEnd: null });
      background({
        cloudDeleteAccount: () => ({ ok: false, reason: 'active_subscription' }),
      });
      await mount();
      await click(button('Supprimer mon compte'));
      await click(button('Oui, supprimer'));
      await until(
        () => text($('#cloud .status')) !== '' && !text($('#cloud .status')).endsWith('…'),
      );
      expect(text($('#cloud .status'))).toBe(
        "Résilie d'abord ton abonnement (Gérer mon abonnement). Tu pourras supprimer ton compte une fois la période payée terminée.",
      );
      expect(button('Me déconnecter')).toBeDefined();
      // The confirmation is closed: nothing is asked twice by mistake.
      expect(button('Oui, supprimer')).toBeUndefined();
      expect(button('Supprimer mon compte')).toBeDefined();
    });

    it.each([
      ['rate_limited', "Trop d'essais. Réessaie dans quelques minutes."],
      [
        'unavailable',
        'Impossible de supprimer ton compte pour le moment. Réessaie dans un instant.',
      ],
      ['network', 'Impossible de joindre Fripon. Vérifie ta connexion, puis réessaie.'],
    ] as const)('says in plain French why it failed (%s)', async (reason, expected) => {
      await signIn(TRIAL_USAGE);
      background({ cloudDeleteAccount: () => ({ ok: false, reason }) });
      await mount();
      await click(button('Supprimer mon compte'));
      await click(button('Oui, supprimer'));
      await until(() => text($('#cloud .status')) === expected);
    });

    it('says so when the background does not answer', async () => {
      await signIn(TRIAL_USAGE);
      vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('gone') as never);
      await mount();
      await click(button('Supprimer mon compte'));
      await click(button('Oui, supprimer'));
      await until(() => text($('#cloud .status')).includes("n'a pas pu lancer la demande"));
    });
  });

  it('follows the account while a Stripe tab is open, then stops once there is a plan', async () => {
    await signIn(TRIAL_USAGE);
    const bg = background({ cloudCheckout: () => ({ ok: true }) });
    await mount();
    await until(() => bg.of('cloudStatus').length > 0);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await click(button('Essentiel — 2,99 €/mois'));
    await until(() => text($('#cloud .status')).includes('nouvel onglet'));
    const before = bg.of('cloudStatus').length;
    await act(() => {
      vi.advanceTimersByTime(5_000);
    });
    await until(() => bg.of('cloudStatus').length > before);

    // The webhook arrived: the plan shows, and the page stops asking.
    await saveStatusFor('tok-1', {
      email: 'moi@exemple.fr',
      usage: PLAN_USAGE,
      subscription: { status: 'active', periodEnd: null },
      checkedAt: Date.now(),
    });
    await until(() => button('Gérer mon abonnement') !== undefined);
    const after = bg.of('cloudStatus').length;
    await act(() => {
      vi.advanceTimersByTime(30_000);
    });
    await settle();
    expect(bg.of('cloudStatus').length).toBe(after);
  });

  it('asks the server again by itself only once when it opens', async () => {
    await signIn(TRIAL_USAGE);
    const bg = background({});
    await mount();
    await settle(100);
    expect(bg.of('cloudStatus')).toHaveLength(1);
  });

  it('asks again on demand', async () => {
    await signIn(TRIAL_USAGE);
    const bg = background({});
    await mount();
    await until(() => bg.of('cloudStatus').length === 1);
    await click(button('Actualiser'));
    await until(() => bg.of('cloudStatus').length === 2);
  });
});

describe('the other sections while signed in', () => {
  it('hide the keys, and tell that their credits are not used', async () => {
    await saveSettings({ keys: { vision: 'AIza' + 'a'.repeat(35) } });
    await signIn(PLAN_USAGE, { status: 'active', periodEnd: null });
    background({});
    await mount();
    // Signed in, the keys serve nothing: their section is not shown at all (the key stays saved).
    expect($('#keys')).toBeNull();
    const credits = $('#credits') as HTMLElement;
    expect(text(credits)).toContain("Tu es connecté à l'abonnement Fripon");
    expect(text(credits)).toContain('12 / 300 ce mois-ci');
    expect(credits.querySelector('a')?.getAttribute('href')).toBe('#cloud');
    // The counters of the keys are not shown: they are not what is spent.
    expect(credits.querySelector('.credit')).toBeNull();
  });

  it('leave the keys and the credits as they were when signed out', async () => {
    background({});
    await mount();
    expect($('#keys')).not.toBeNull();
    expect(root.querySelectorAll('#credits .credit')).toHaveLength(2);
    expect(text($('#keys'))).toContain('Sans abonnement, tes clés restent dans ce navigateur');
  });

  it('keep the welcome banner for those who need a Google key only', async () => {
    background({});
    await mount();
    expect($('#welcome')).not.toBeNull();
    render(null, root);
    await signIn(TRIAL_USAGE);
    await mount();
    expect($('#welcome')).toBeNull();
  });
});
