import { formatMoney } from '../../../lib/format';
import { HOST, PUBLISHER, type Publisher } from './entity';

/**
 * What the two legal pages (`/cgv`, `/confidentialite`) share: the page around the text, the
 * placeholders the owner still has to fill in, and the few formatters that turn the server's own
 * constants (prices, caps, retention periods) into French, so that a number is written once, in
 * the code, and the text follows it.
 *
 * Both pages are DRAFTS until `LEGAL_PAGES_FINAL=true` (see `config.ts`). They are not legal advice.
 */

/** The banner every draft page wears until the owner sets `LEGAL_PAGES_FINAL=true`. */
export const DRAFT_BANNER = "Brouillon à faire relire — ne pas publier en l'état";

/**
 * The date of the texts, shown on both pages. Move it whenever a text changes, and send the
 * subscribers their notice (the terms promise 30 days).
 */
export const LEGAL_VERSION_DATE = '2026-10-28';

/**
 * A fact the owner has to give (a name, an address, a number...). Written exactly like this on
 * purpose: `grep -rn "À COMPLÉTER" server/src/legal` finds what is left, and the server warns at
 * start when the pages are marked final while some remain.
 */
export function todo(what: string): string {
  return `<mark class="todo">[À COMPLÉTER : ${what}]</mark>`;
}

/** What marks a placeholder in a rendered page (the start of every `todo`). */
export const TODO_MARK = '[À COMPLÉTER';

/** What each unfilled field of the publisher says in its placeholder. One entry per field: a new field is a type error until it has its words. */
export const PUBLISHER_LABELS: Record<keyof Publisher, string> = {
  companyName: 'dénomination sociale de la société éditrice',
  legalForm: 'forme juridique (SAS, SARL…)',
  shareCapital: 'capital social',
  registeredOffice: 'adresse du siège social',
  rcs: 'ville du greffe et numéro RCS',
  siret: 'numéro SIRET',
  vat: 'numéro de TVA intracommunautaire, ou mention de la franchise en base de TVA',
  publicationDirector: 'nom du directeur de la publication',
  contactEmail: 'adresse e-mail de contact',
  mediatorName: 'nom du médiateur de la consommation',
  mediatorAddress: 'adresse postale du médiateur de la consommation',
  mediatorWebsite: 'site internet du médiateur de la consommation',
};

/**
 * One detail of the publisher, ready for a page: its value (escaped: a company can be « Dupont &
 * Fils »), or the placeholder of its label while it is `null` (a blank string counts as not filled).
 */
export function publisherField(publisher: Publisher, key: keyof Publisher): string {
  const value = publisher[key]?.trim();
  return value ? escapeHtml(value) : todo(PUBLISHER_LABELS[key]);
}

/**
 * The reminder next to every paragraph about Stripe acting as merchant of record: the owner has to
 * check it against the Managed Payments terms in the Stripe Dashboard (the exact Stripe entity and
 * its buyer terms are not known here, so neither page names one). Delete the `todo` once checked.
 */
export const STRIPE_PARAGRAPH_CHECK =
  'vérifier ce paragraphe avec les conditions Managed Payments de Stripe (tableau de bord Stripe)';

/** `299` is "2,99 €": cents in, a French price out (the same formatter as the extension's). */
export const euros = (cents: number): string =>
  formatMoney({ amount: cents / 100, currency: 'EUR' });

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A retention period in words: "15 minutes", "24 heures", "90 jours", "12 mois". Under two days it
 * is counted in hours (a day of anti-abuse memory reads "24 heures"), 365 days are "12 mois".
 */
export function duration(ms: number): string {
  if (ms === 365 * DAY_MS) return '12 mois';
  if (ms >= 2 * DAY_MS) return `${Math.round(ms / DAY_MS)} jours`;
  if (ms >= HOUR_MS) {
    const hours = Math.round(ms / HOUR_MS);
    return hours === 1 ? '1 heure' : `${hours} heures`;
  }
  return `${Math.round(ms / MINUTE_MS)} minutes`;
}

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

/** `2026-10-27` is "27 octobre 2026". */
export function frenchDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return `${day === 1 ? '1er' : day} ${MONTHS[month - 1] ?? ''} ${year}`;
}

/** Text from a constant, made safe to drop in a page (no quote escaping: the text sits between tags). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The publisher, host and contact: the legal notice of the terms (the company's name, form,
 * capital, registered office, RCS, SIRET, VAT, director of publication, contact, host), and the
 * controller of the privacy policy. Everything comes from `entity.ts`.
 */
export function publisherList(serviceUrl: string, publisher: Publisher = PUBLISHER): string {
  const field = (key: keyof Publisher) => publisherField(publisher, key);
  return `<ul>
<li>Éditeur et responsable du service : ${field('companyName')}, ${field('legalForm')}</li>
<li>Capital social : ${field('shareCapital')}</li>
<li>Siège social : ${field('registeredOffice')}</li>
<li>Immatriculation au RCS : ${field('rcs')}</li>
<li>SIRET : ${field('siret')}</li>
<li>TVA : ${field('vat')}</li>
<li>Directeur de la publication : ${field('publicationDirector')}</li>
<li>Contact : ${field('contactEmail')}</li>
<li>Hébergeur : ${escapeHtml(HOST.name)}, ${escapeHtml(HOST.address)} (le serveur est dans ${escapeHtml(HOST.datacentre)})</li>
<li>Adresse du service : ${escapeHtml(serviceUrl)}</li>
</ul>`;
}

/** A tiny stylesheet in the spirit of `/billing/done`: system font, light and dark, no external resource. */
const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; font: 18px/1.55 system-ui, sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }
h1 { margin: 0 0 0.5rem; font-size: 1.6rem; line-height: 1.25; }
h2 { margin: 2rem 0 0.5rem; font-size: 1.2rem; line-height: 1.3; }
h3 { margin: 1.25rem 0 0.25rem; font-size: 1.05rem; }
p, ul { margin: 0 0 0.9rem; }
ul { padding-left: 1.25rem; }
li { margin-bottom: 0.35rem; }
a { overflow-wrap: anywhere; }
.meta { font-size: 0.9rem; opacity: 0.8; }
.draft { margin: 0 0 1.25rem; padding: 0.75rem 1rem; border: 2px solid #b45309; border-radius: 0.5rem; background: #fef3c7; color: #451a03; font-weight: 600; }
mark.todo { background: #fde68a; color: #451a03; padding: 0 0.2rem; border-radius: 0.2rem; }
.scroll { overflow-x: auto; margin: 0 0 0.9rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
th, td { padding: 0.4rem 0.5rem; border-bottom: 1px solid rgba(127, 127, 127, 0.5); text-align: left; vertical-align: top; }
.item { margin: 0 0 1.25rem; padding-left: 0.75rem; border-left: 3px solid rgba(127, 127, 127, 0.5); }
.item p { margin: 0 0 0.4rem; }
`;

export interface LegalPageOptions {
  title: string;
  /** The other page, offered under the title: its address and its name. */
  seeAlso: { href: string; label: string };
  /** True once the owner has reviewed the texts and set `LEGAL_PAGES_FINAL`. */
  final: boolean;
  /** The page's HTML, written by `cgv.ts` and `privacy.ts`. */
  body: string;
}

/**
 * A static page: no script, no external resource, nothing personal. While it is a draft it shows
 * the banner and asks search engines to skip it.
 */
export function legalPage({ title, seeAlso, final, body }: LegalPageOptions): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${final ? '' : '<meta name="robots" content="noindex">\n'}<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${final ? '' : `<p class="draft" role="note">${DRAFT_BANNER}</p>\n`}<h1>${title}</h1>
<p class="meta">Version du ${frenchDate(LEGAL_VERSION_DATE)} · Voir aussi : <a href="${seeAlso.href}">${seeAlso.label}</a></p>
${body}
<p class="meta">Version du ${frenchDate(LEGAL_VERSION_DATE)}.</p>
</main>
</body>
</html>
`;
}
