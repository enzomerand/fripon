import { describe, expect, it } from 'vitest';
import { cgvBody } from './cgv';
import { HOST, MAIL_PROVIDER, PUBLISHER, type Publisher } from './entity';
import {
  PUBLISHER_LABELS,
  STRIPE_PARAGRAPH_CHECK,
  TODO_MARK,
  publisherField,
  publisherList,
} from './page';
import { privacyBody } from './privacy';
import { FILLED_PUBLISHER } from './test-publisher';

const SERVICE = 'https://cloud.fripon.test';
const FIELDS = Object.keys(FILLED_PUBLISHER) as (keyof Publisher)[];

const pages = (publisher: Publisher) => ({
  cgv: cgvBody(SERVICE, publisher),
  privacy: privacyBody(SERVICE, publisher),
});
const marks = (html: string) => html.split(TODO_MARK).length - 1;
/** A publisher with nothing filled in yet, as the object is committed. */
const NOT_FILLED: Publisher = {
  companyName: null,
  legalForm: null,
  shareCapital: null,
  registeredOffice: null,
  rcs: null,
  siret: null,
  vat: null,
  publicationDirector: null,
  contactEmail: null,
  mediatorName: null,
  mediatorAddress: null,
  mediatorWebsite: null,
};

describe('the publisher object (entity.ts)', () => {
  it('lists every field, each one a string or null, and the pages have words for each', () => {
    expect(Object.keys(PUBLISHER).sort()).toEqual([...FIELDS].sort());
    expect(Object.keys(PUBLISHER_LABELS).sort()).toEqual([...FIELDS].sort());
    for (const value of Object.values(PUBLISHER)) {
      expect(value === null || (typeof value === 'string' && value.trim() !== '')).toBe(true);
    }
  });

  it('holds the host and the e-mail provider as filled facts, not placeholders', () => {
    expect(HOST).toMatchObject({
      name: 'OVH SAS',
      address: '2 rue Kellermann, 59100 Roubaix, France',
    });
    expect(HOST.datacentre).toContain('Strasbourg');
    expect(MAIL_PROVIDER).toMatchObject({
      name: 'Brevo',
      company: 'Sendinblue SAS',
      address: '106 boulevard Haussmann, 75008 Paris, France',
    });
  });
});

describe('publisherField', () => {
  it('gives the value, escaped, or a placeholder with the label of the field', () => {
    expect(publisherField(FILLED_PUBLISHER, 'companyName')).toBe('Zorglub &amp; Fils');
    expect(publisherField(NOT_FILLED, 'siret')).toBe(
      `<mark class="todo">${TODO_MARK} : numéro SIRET]</mark>`,
    );
  });

  it('counts a blank string as not filled', () => {
    expect(publisherField({ ...FILLED_PUBLISHER, siret: '   ' }, 'siret')).toContain(TODO_MARK);
    expect(publisherField({ ...FILLED_PUBLISHER, siret: '' }, 'siret')).toContain(TODO_MARK);
  });
});

describe('the pages read the publisher from the object', () => {
  it('print every filled field, escaped, in the legal notice of both pages', () => {
    const { cgv, privacy } = pages(FILLED_PUBLISHER);

    for (const html of [cgv, privacy]) {
      expect(html).toContain('Éditeur et responsable du service : Zorglub &amp; Fils, SAS Test');
      expect(html).toContain('Capital social : 4 242 euros');
      expect(html).toContain('Siège social : 7 impasse du Test, 99999 Testville');
      expect(html).toContain('Immatriculation au RCS : Testville B 000 111 222');
      expect(html).toContain('SIRET : 000 111 222 00033');
      expect(html).toContain('TVA : FR00000111222');
      expect(html).toContain('Directeur de la publication : Zoé Directrice');
      expect(html).toContain('Contact : contact@zorglub.test');
      expect(html).not.toContain('Zorglub & Fils');
    }
    // The contact is also where the terms and the rights ask to write to.
    expect(cgv).toContain("écrivez à l'éditeur (contact@zorglub.test)");
    expect(privacy).toContain('Écrivez à contact@zorglub.test.');
    // The mediator is in the terms.
    expect(cgv).toContain(
      "Médiateur de la consommation de l'éditeur : Médiation Test, 1 place du Médiateur, 99998 Médiaville, www.mediation.test.",
    );
  });

  it('leave no placeholder once the object is filled, except the Stripe check', () => {
    const { cgv, privacy } = pages(FILLED_PUBLISHER);

    for (const html of [cgv, privacy]) {
      expect(marks(html)).toBe(1);
      expect(html).toContain(`<mark class="todo">${TODO_MARK} : ${STRIPE_PARAGRAPH_CHECK}]</mark>`);
    }
    // The company is not an individual any more.
    expect(cgv).not.toContain('Enzo Mérand');
    expect(privacy).not.toContain('Enzo Mérand');
  });

  it('show one placeholder per unfilled field, each with its own label', () => {
    const { cgv, privacy } = pages(NOT_FILLED);

    for (const key of FIELDS) {
      expect(cgv, key).toContain(PUBLISHER_LABELS[key]);
      // Everything but the mediator is in the privacy policy too.
      if (!key.startsWith('mediator')) expect(privacy, key).toContain(PUBLISHER_LABELS[key]);
    }
    expect(publisherList(SERVICE, NOT_FILLED)).toContain(PUBLISHER_LABELS.vat);
  });

  it('turn into a placeholder each field that is emptied, and only that one', () => {
    const baseline = pages(FILLED_PUBLISHER);

    for (const key of FIELDS) {
      const emptied = pages({ ...FILLED_PUBLISHER, [key]: null });
      const value = FILLED_PUBLISHER[key] as string;
      const escaped = value.replace(/&/g, '&amp;');
      expect(emptied.cgv, key).toContain(PUBLISHER_LABELS[key]);
      expect(emptied.cgv, key).not.toContain(escaped);
      expect(marks(emptied.cgv), key).toBeGreaterThan(marks(baseline.cgv));
      // The other fields stay where they were.
      for (const other of FIELDS.filter((name) => name !== key)) {
        const text = (FILLED_PUBLISHER[other] as string).replace(/&/g, '&amp;');
        expect(emptied.cgv, `${key} emptied, ${other}`).toContain(text);
      }
    }
  });

  it('name the host and the e-mail provider from the object, with the countries and no transfer', () => {
    const { cgv, privacy } = pages(FILLED_PUBLISHER);

    expect(cgv).toContain(
      `Hébergeur : ${HOST.name}, ${HOST.address} (le serveur est dans ${HOST.datacentre})`,
    );
    expect(publisherList(SERVICE, FILLED_PUBLISHER)).toContain('OVH SAS, 2 rue Kellermann');
    expect(privacy).toContain(`<strong>L'hébergeur</strong> (${HOST.name}, ${HOST.address})`);
    expect(privacy).toContain(
      `<strong>Le prestataire d'envoi d'e-mails</strong> (${MAIL_PROVIDER.name} (${MAIL_PROVIDER.company}), ${MAIL_PROVIDER.address})`,
    );
    expect(privacy).toContain(
      "L'hébergeur traite les données en France et le prestataire d'envoi d'e-mails dans l'Union européenne : aucun transfert hors de l'Union européenne n'est fait vers eux.",
    );
  });
});
