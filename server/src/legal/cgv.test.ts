import { describe, expect, it, vi } from 'vitest';
import { TERMS_MESSAGE } from '../routes/billing';
import { CHANGE_NOTICE_DAYS, cgvBody } from './cgv';

// Every figure of the terms must come from the server's own constants. They are swapped here for
// values nobody would type by hand: a price, a cap, the trial or the review limit retyped in the
// text would still show its real value, and the checks below would fail.
vi.mock('../plans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plans')>()),
  TRIAL_ANALYSES: 7,
  PLAN_CAPS: {
    essentiel: { monthCap: 123, dayCap: 12 },
    revendeur: { monthCap: 4567, dayCap: 456 },
  },
  PRICE_SPECS: {
    essentiel_monthly: { plan: 'essentiel', amount: 1234, interval: 'month', nickname: 'a' },
    essentiel_yearly: { plan: 'essentiel', amount: 56789, interval: 'year', nickname: 'b' },
    revendeur_monthly: { plan: 'revendeur', amount: 4321, interval: 'month', nickname: 'c' },
  },
}));
vi.mock('../quota', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../quota')>()),
  REVIEWS_PER_PHOTO: 9,
}));

const html = cgvBody('https://cloud.fripon.test');

/** The text of the table row of an offer. */
const row = (label: string) =>
  (html.match(new RegExp(`<tr><th scope="row">${label}</th>(.*?)</tr>`)) ?? [])[1] ?? '';

describe('the terms of sale', () => {
  it('print the prices, caps, trial and review limit of the constants, not typed ones', () => {
    expect(row('Essentiel mensuel')).toMatch(/12,34\s€ TTC par mois.*123.*12/);
    expect(row('Essentiel annuel')).toMatch(/567,89\s€ TTC par an.*123.*12/);
    expect(row('Revendeur mensuel')).toMatch(/43,21\s€ TTC par mois.*4\s567.*456/);
    expect(html).toContain('7 analyses au total');
    expect(html).toContain('9 avis par annonce et par mois');

    // None of the real figures is written anywhere.
    expect(html).not.toMatch(/2,99|29,99|6,99/);
    expect(html).not.toMatch(/\b300\b|\b40\b|\b100\b|1\s000/);
    expect(html).not.toContain('15 analyses');
    expect(html).not.toContain('3 avis');
  });

  it('list every price of the table once, whatever the constants hold', () => {
    expect(html.match(/<tr><th scope="row">/g)).toHaveLength(3);
  });

  it("quote the exact words the buyer ticks at Checkout, with the law's article", () => {
    expect(html).toContain(TERMS_MESSAGE);
    expect(html).toContain('L221-28, 13°');
    expect(html).toContain('14 jours');
  });

  it('promise the notice period of a change by the constant, and name the withdrawal, cancellation and mediation', () => {
    expect(CHANGE_NOTICE_DAYS).toBe(30);
    expect(html).toContain(`au moins ${CHANGE_NOTICE_DAYS} jours avant`);
    expect(html).toContain('« Gérer mon abonnement »');
    expect(html).toContain('à la fin de la période déjà payée');
    expect(html).toContain('médiateur de la consommation');
    expect(html).toContain('Stripe');
    expect(html).toContain("n'est pas affilié à Vinted");
    expect(html).toContain('href="/confidentialite"');
  });
});
