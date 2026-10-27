import { formatMoney } from '../../../lib/format';

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
export const LEGAL_VERSION_DATE = '2026-10-27';

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

/** The owner's contact address, asked for in several places. */
export const contact = (): string => todo('adresse e-mail de contact');

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

/** The publisher, host and contact: the legal notice of the terms, and the controller of the privacy policy. */
export function publisherList(serviceUrl: string): string {
  return `<ul>
<li>Éditeur et responsable du service : Enzo Mérand, ${todo('statut juridique (entrepreneur individuel, société…) et dénomination ou raison sociale')}</li>
<li>Adresse : ${todo("adresse postale de l'éditeur")}</li>
<li>SIRET : ${todo('numéro SIRET')}</li>
<li>TVA : ${todo('numéro de TVA intracommunautaire, ou mention de la franchise en base de TVA')}</li>
<li>Directeur de la publication : ${todo('nom du directeur de la publication')}</li>
<li>Contact : ${contact()}</li>
<li>Hébergeur : ${todo("nom de l'hébergeur")}, ${todo("adresse de l'hébergeur")}</li>
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
