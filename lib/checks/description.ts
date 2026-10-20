import type { CheckResult, Listing, Signal } from '../model';

/** Score at or above which the text is flagged as marketplace / machine-translated copy. */
export const MARKETPLACE_SCORE_THRESHOLD = 3;

/** Named weights of the marketplace-style rules. One rule alone never reaches the threshold, except a pile of spec lines. */
export const WEIGHTS = {
  englishApparelTitle: 2,
  keywordStacking: 2,
  /** Per distinct spec-sheet key ("Style", "Saison"…), capped at `specLinesCap`. */
  specLine: 1,
  specLinesCap: 3,
  fiberBlend: 1,
  yearNewArrival: 2,
  sizeChartPhrase: 2,
  sizeTableLines: 1,
  packageContents: 2,
  promoWords: 1,
} as const;

/** A title or line with at least this many Capitalised Words reads as keyword stacking. */
export const STACKING_MIN_CAPITALISED = 6;
/** ...and the capitalised words must be at least this share of its words. */
export const STACKING_MIN_CAPITALISED_SHARE = 0.7;
/** A title made of at least this many comma / pipe / slash separated keywords reads as keyword stacking. */
export const STACKING_MIN_SEPARATORS = 4;
/** A size chart needs at least this many "M: 92 cm" lines to count. */
export const SIZE_TABLE_MIN_LINES = 3;
/** This many distinct promo words together are a sales pitch, not a personal description. */
export const PROMO_MIN_DISTINCT = 3;

/** Below this many words the language cannot be guessed reliably: the rules run anyway. */
export const LANGUAGE_MIN_WORDS = 6;
/** Share of French or English hint words above which the text counts as French or English. */
export const LANGUAGE_MIN_HINT_RATIO = 0.1;

/** Stop words plus the apparel vocabulary of product copy, which has almost no stop words. */
const HINTS_FR = new Set(
  (
    'le la les des une du et est dans pour pas avec sur très mais au aux cette elle sont je ce qui il ils par plus ne se sa son ses mon ma mes ont été jamais porté portée vendu comme tout bien état taille ' +
    'femme femmes homme hommes fille garçon robe chemise haut jupe pantalon matière style saison hiver manches col imprimé fleurie fleuri longueur couleur veuillez tissu coton colis comprend'
  ).split(' '),
);
const HINTS_EN = new Set(
  (
    'the and of to is for with this that it are on be as at by or not very was you your size new have has been worn only ' +
    'women woman men ladies girls boys dress shirt top casual material polyester spandex cotton season summer winter spring autumn sleeve sleeves neck print floral short long length bust chart please allow error manual measurement color colour fabric fashion elegant package includes'
  ).split(' '),
);
/** Distinctive German, Spanish and Italian stop words, only used to rule out those languages. */
const STOPWORDS_OTHER = [
  new Set(
    'der die das und ist nicht mit für ein eine einen auf sehr ich wie noch auch von zu es wurde'.split(
      ' ',
    ),
  ),
  new Set(
    'el los las una unos con para por muy pero está estoy talla usado nuevo como del y que se'.split(
      ' ',
    ),
  ),
  new Set(
    'il gli di che per con una non sono molto ma come anche taglia nuovo usato è stato'.split(' '),
  ),
];

const NO_BRAND_PLACEHOLDERS =
  /^(?:sans[\s-]?marque|no[\s-]?brand|unbranded|ohne[\s-]?marke|markenlos|sin[\s-]?marca|senza[\s-]?marca|sem[\s-]?marca|zonder[\s-]?merk|bez[\s-]?marki|generic|generique|marque[\s-]?inconnue|unknown)$/;

const APPAREL_WORD =
  'dress|shirt|blouse|top|tee|t-shirt|pants|trousers|jeans|skirt|jacket|coat|sweater|hoodie|shorts|jumpsuit|romper|cardigan|vest|bra|bikini|swimsuit';
const ENGLISH_APPAREL_TITLE = new RegExp(
  `\\b(?:women|woman|men|ladies|lady|girls?|boys?|kids?)(?:'s|s)?\\b.*\\b(?:casual|elegant|fashion|summer|winter|autumn|spring|party|loose|sexy|slim|solid|floral|plus size|oversized|streetwear)\\b.*\\b(?:${APPAREL_WORD})\\b`,
  'i',
);

/** "Matière : Polyester", "Style: Casual", "Season: Summer"… at the start of a line. */
const SPEC_LINE_KEYS: Array<[key: string, pattern: RegExp]> = [
  ['material', /^(?:matiere|materiau|material|tissu|fabric|composition)\s*:\s*\S/i],
  ['style', /^(?:style|type de style)\s*:\s*\S/i],
  ['season', /^(?:saison|season)\s*:\s*\S/i],
  ['occasion', /^(?:occasion|evenement)\s*:\s*\S/i],
  ['pattern', /^(?:motif|pattern|imprime|pattern type)\s*:\s*\S/i],
  ['neckline', /^(?:col|type de col|neckline|collar)\s*:\s*\S/i],
  ['sleeve', /^(?:manches?|sleeves?|longueur des manches|sleeve length)\s*:\s*\S/i],
  ['length', /^(?:longueur|length)\s*:\s*\S/i],
  ['closure', /^(?:fermeture|closure|type de fermeture)\s*:\s*\S/i],
  ['fit', /^(?:coupe|fit|fit type|silhouette)\s*:\s*\S/i],
  ['gender', /^(?:genre|gender|departement|department)\s*:\s*\S/i],
  ['decoration', /^(?:decoration|decoration|details?|details?)\s*:\s*\S/i],
];
const SPEC_LINE_BULLET = /^[\s\-–•*▪✔✅➤►·]+/u;

const FIBER_BLEND = /\b\d{1,3}\s?%\s?(?:polyester|spandex|polyamide)/gi;
const YEAR_NEW_ARRIVAL =
  /\b20[1-3]\d\b.{0,24}\b(?:nouveau|nouvelle|nouveautes?|new(?:\s+arrival)?s?|hot\s+sale)\b|\b(?:nouveau|nouvelle|nouveautes?|new\s+arrivals?|hot\s+sale)\b.{0,24}\b20[1-3]\d\b/i;
const SIZE_CHART_PHRASE =
  /\bsize\s+(?:chart|guide)\b|\bguide\s+des\s+tailles\b|\btableau\s+(?:des\s+)?tailles\b|\bmanual\s+measurement|\bmesure\s+manuelle|\b1\s?-\s?3\s?cm\b|\b1\s?a\s?3\s?cm\b|\b1\s?inch\s?=\s?2\.54|\b1\s?cm\s?=\s?0\.39/i;
const SIZE_TABLE_LINE =
  /(?:^|\s)(?:xxs|xs|s|m|l|xl|xxl|xxxl|[2-5]xl)\s*[:：=-]\s*[^\n]{0,30}?\d+(?:[.,]\d+)?\s?(?:cm|in)\b/gim;
const PACKAGE_CONTENTS =
  /\bpackage\s+(?:includes?|contents?)\b|\bpackage\s*:\s*1\b|\bcontenu\s+du\s+(?:colis|paquet)\b|\ble\s+colis\s+(?:comprend|contient)\b|\b1\s?[x×]\s+(?:dress|robe|shirt|top|blouse|jupe|skirt|pants|pantalon|tee)\b|\bdue\s+to\s+(?:the\s+)?(?:different\s+)?(?:monitors?|lighting|screens?)\b|\bdifferences?\s+de\s+couleurs?\s+dues?\b/i;
const PROMO_WORDS: Array<[key: string, pattern: RegExp]> = [
  ['quality', /\bhaute\s+qualite|\b(?:high|premium|superior)\s+quality\b/i],
  ['hot', /\bhot\s+sale\b|\bbest[\s-]?seller\b|\bvente\s+chaude\b/i],
  ['shipping', /\bfree\s+shipping\b|\blivraison\s+(?:gratuite|rapide)\b/i],
  ['trend', /\btrendy\b|\ba\s+la\s+mode\b|\btendance\b|\bfashionable\b|\bstylish\b/i],
  ['perfect', /\bperfect\s+for\b|\bparfaite?\s+pour\b|\bideale?\s+pour\b|\bideal\s+for\b/i],
  ['suitable', /\bsuitable\s+for\b|\badaptee?\s+(?:a|pour)\b/i],
  ['breathable', /\bbreathable\b|\brespirante?\b/i],
  ['elegant', /\belegant(?:e|s|es)?\b/i],
];

export type MarketplaceReason =
  | 'english_title'
  | 'keyword_stacking'
  | 'spec_sheet'
  | 'year_new_arrival'
  | 'size_chart'
  | 'package_contents'
  | 'promo_words';

export interface MarketplaceScore {
  score: number;
  reasons: MarketplaceReason[];
}

const REASON_LABELS: Record<MarketplaceReason, string> = {
  english_title: 'titre en anglais type boutique',
  keyword_stacking: 'mots-clés empilés',
  spec_sheet: 'fiche technique',
  year_new_arrival: 'année + « nouveau »',
  size_chart: 'tableau de tailles',
  package_contents: 'contenu du colis',
  promo_words: 'vocabulaire promo',
};

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

function words(text: string): string[] {
  return text.toLowerCase().match(/\p{L}+/gu) ?? [];
}

function hintRatio(tokens: string[], stop: Set<string>): number {
  if (tokens.length === 0) return 0;
  return tokens.filter((t) => stop.has(t)).length / tokens.length;
}

/** true when the text is French or English (or too short to tell: the rules are harmless then). */
export function looksFrenchOrEnglish(text: string): boolean {
  const tokens = words(text);
  const frEn = Math.max(hintRatio(tokens, HINTS_FR), hintRatio(tokens, HINTS_EN));
  const other = Math.max(...STOPWORDS_OTHER.map((stop) => hintRatio(tokens, stop)));
  if (tokens.length < LANGUAGE_MIN_WORDS) return frEn >= other;
  return frEn >= LANGUAGE_MIN_HINT_RATIO && frEn >= other;
}

export function isNoBrand(brand: string | null): boolean {
  if (brand === null) return true;
  const normalized = stripAccents(brand.toLowerCase()).trim();
  return normalized === '' || NO_BRAND_PLACEHOLDERS.test(normalized);
}

/** "Elegant Women Summer Floral Print Dress" or "robe, femme, été, fleurie, casual". */
function looksStacked(line: string): boolean {
  const tokens = line.split(/\s+/).filter(Boolean);
  const capitalised = tokens.filter((t) => /^\p{Lu}\p{Ll}/u.test(t)).length;
  if (
    capitalised >= STACKING_MIN_CAPITALISED &&
    capitalised / tokens.length >= STACKING_MIN_CAPITALISED_SHARE
  ) {
    return true;
  }
  return (line.match(/[,|/·•]/g) ?? []).length >= STACKING_MIN_SEPARATORS;
}

function specKeys(lines: string[]): number {
  const found = new Set<string>();
  for (const raw of lines) {
    const line = raw.replace(SPEC_LINE_BULLET, '');
    for (const [key, pattern] of SPEC_LINE_KEYS) {
      if (pattern.test(line)) found.add(key);
    }
  }
  return found.size;
}

/** Scores how much a title + description reads like marketplace or machine-translated product copy. */
export function scoreMarketplaceStyle(title: string, description: string): MarketplaceScore {
  // Accents are stripped once so that the patterns below can stay ASCII (\b does not like "à").
  const plainTitle = stripAccents(title);
  const plainDescription = stripAccents(description);
  const plain = `${plainTitle}\n${plainDescription}`;
  const segments = plain
    .split(/[\r\n|;•]+/u)
    .map((l) => l.trim())
    .filter(Boolean);
  const reasons: MarketplaceReason[] = [];
  let score = 0;
  const add = (reason: MarketplaceReason, weight: number) => {
    reasons.push(reason);
    score += weight;
  };

  if (ENGLISH_APPAREL_TITLE.test(plainTitle)) add('english_title', WEIGHTS.englishApparelTitle);

  const headlines = [plainTitle, ...plainDescription.split(/\r?\n/).slice(0, 3)];
  if (headlines.some((h) => looksStacked(h.trim()))) {
    add('keyword_stacking', WEIGHTS.keywordStacking);
  }

  const blend = (plain.match(FIBER_BLEND) ?? []).length >= 2;
  const specScore =
    Math.min(specKeys(segments) * WEIGHTS.specLine, WEIGHTS.specLinesCap) +
    (blend ? WEIGHTS.fiberBlend : 0);
  if (specScore > 0) add('spec_sheet', specScore);

  if (YEAR_NEW_ARRIVAL.test(plain)) add('year_new_arrival', WEIGHTS.yearNewArrival);

  if (SIZE_CHART_PHRASE.test(plain)) add('size_chart', WEIGHTS.sizeChartPhrase);
  else if ((plain.match(SIZE_TABLE_LINE) ?? []).length >= SIZE_TABLE_MIN_LINES) {
    add('size_chart', WEIGHTS.sizeTableLines);
  }

  if (PACKAGE_CONTENTS.test(plain)) add('package_contents', WEIGHTS.packageContents);

  const promo = PROMO_WORDS.filter(([, pattern]) => pattern.test(plain)).length;
  if (promo >= PROMO_MIN_DISTINCT) add('promo_words', WEIGHTS.promoWords);

  return { score, reasons };
}

export function checkDescription(listing: Listing): CheckResult {
  const text = `${listing.title}\n${listing.description}`;
  if (!looksFrenchOrEnglish(text)) {
    return {
      id: 'description',
      status: 'off',
      tag: 'Non disponible',
      detail: 'Vérification non disponible dans cette langue.',
      signals: [],
    };
  }

  const signals: Signal[] = [];
  const { score, reasons } = scoreMarketplaceStyle(listing.title, listing.description);
  const storeStyle = score >= MARKETPLACE_SCORE_THRESHOLD;
  const noBrand = isNoBrand(listing.brand);

  if (storeStyle) signals.push({ id: 'marketplace_style_text', strength: 'weak' });
  if (noBrand) signals.push({ id: 'no_brand', strength: 'weak' });

  let detail = storeStyle
    ? `Le texte ressemble à une fiche produit de boutique en ligne (${reasons
        .map((r) => REASON_LABELS[r])
        .join(', ')}).`
    : "Le texte a l'air d'une vraie annonce de particulier.";
  if (noBrand) detail += ' Aucune marque indiquée.';

  return {
    id: 'description',
    status: storeStyle ? 'warn' : 'ok',
    tag: storeStyle ? 'Style boutique' : 'Normale',
    detail,
    signals,
  };
}
