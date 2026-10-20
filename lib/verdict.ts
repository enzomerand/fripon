import { formatMoney, formatRatio } from './format';
import type { CheckResult, ImageMatch, SignalId, Verdict } from './model';

/** An exact image match sold at least this many times its original price is dropshipping. */
export const DROPSHIP_PRICE_RATIO = 2;
/**
 * Without any stronger evidence, weak signals call for a closer look only when they come from
 * this many distinct families: two hints about the same thing (a catalogue-looking photo that is
 * also reused) are one hint, not two.
 */
export const REVIEW_MIN_WEAK_FAMILIES = 2;
/** From this ratio on, the price gap is worth a line of its own ("Vendu ici 3,8× plus cher"). */
export const PRICE_LINE_MIN_RATIO = 1.5;
/** The collapsed card shows at most this many lines. */
export const MAX_LINES = 2;

export interface VerdictInput {
  checks: CheckResult[];
  imageMatches: ImageMatch[];
  /** Vinted price divided by the original price of the exact match, null when unknown. */
  priceRatio: number | null;
}

/** Short French line for each signal, most telling first (used to order lines of equal strength). */
const SIGNAL_LINES: Array<[SignalId, string]> = [
  ['catalog_photo', 'Photo type catalogue'],
  ['stock_multiple_sizes', 'Même article en plusieurs tailles'],
  ['mostly_new_with_tags', 'Surtout du neuf avec étiquette'],
  ['price_above_similar', 'Plus cher que les annonces similaires'],
  ['photo_reused', "Même photo sur d'autres annonces"],
  ['new_account', 'Vendeur récemment inscrit'],
  ['marketplace_style_text', 'Description style boutique en ligne'],
  ['few_reviews', "Vendeur avec peu d'avis"],
  ['no_brand', 'Aucune marque indiquée'],
];

type SignalFamily = 'profile' | 'text' | 'photo' | 'price' | 'wardrobe';

const SIGNAL_FAMILY: Record<SignalId, SignalFamily> = {
  few_reviews: 'profile',
  new_account: 'profile',
  no_brand: 'text',
  marketplace_style_text: 'text',
  catalog_photo: 'photo',
  photo_reused: 'photo',
  price_above_similar: 'price',
  stock_multiple_sizes: 'wardrobe',
  mostly_new_with_tags: 'wardrobe',
};

interface Collected {
  strong: SignalId[];
  weak: SignalId[];
}

/** Distinct signals across all checks; a signal reported strong anywhere counts as strong. */
function collectSignals(checks: CheckResult[]): Collected {
  const strength = new Map<SignalId, 'strong' | 'weak'>();
  for (const check of checks) {
    for (const signal of check.signals) {
      if (strength.get(signal.id) !== 'strong') strength.set(signal.id, signal.strength);
    }
  }
  const ordered = SIGNAL_LINES.map(([id]) => id).filter((id) => strength.has(id));
  return {
    strong: ordered.filter((id) => strength.get(id) === 'strong'),
    weak: ordered.filter((id) => strength.get(id) === 'weak'),
  };
}

function signalLine(id: SignalId): string {
  return SIGNAL_LINES.find(([candidate]) => candidate === id)?.[1] ?? '';
}

/** The exact match to quote: the cheapest priced one, else the first. */
function pickExactMatch(exact: ImageMatch[]): ImageMatch | undefined {
  const priced = exact.filter((m) => m.price !== null);
  if (priced.length === 0) return exact[0];
  return priced.reduce((best, m) =>
    (m.price?.amount ?? 0) < (best.price?.amount ?? 0) ? m : best,
  );
}

function cleanRatio(ratio: number | null): number | null {
  return ratio !== null && Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

function exactLines(match: ImageMatch, ratio: number | null): string[] {
  const lines = [
    match.price
      ? `Même photo sur ${match.platform} à ${formatMoney(match.price)}`
      : `Même photo sur ${match.platform}`,
  ];
  if (ratio !== null) {
    lines.push(
      ratio >= PRICE_LINE_MIN_RATIO
        ? `Vendu ici ${formatRatio(ratio)}× plus cher`
        : "Prix correct par rapport à l'original",
    );
  }
  return lines;
}

/**
 * Combines the check results into the final verdict, following design section 6:
 *
 * - exact image match + (price >= 2x the original, or unknown price and a strong signal): dropshipping;
 * - exact image match otherwise: an honest resale of a Shein / Temu… item;
 * - non-exact match, price above similar listings, a strong signal or weak ones from several
 *   families: to verify;
 * - nothing: clean (and it says so when the image search did not run).
 */
export function computeVerdict(input: VerdictInput): Verdict {
  const ratio = cleanRatio(input.priceRatio);
  const { strong, weak } = collectSignals(input.checks);
  const imageCheck = input.checks.find((c) => c.id === 'image');
  const withoutImageSearch = !imageCheck || imageCheck.status === 'off';

  const exact = pickExactMatch(input.imageMatches.filter((m) => m.exact));
  const similar = input.imageMatches.find((m) => !m.exact);
  const signalLines = [...strong, ...weak].map(signalLine);

  if (exact) {
    const dropshipping = ratio !== null ? ratio >= DROPSHIP_PRICE_RATIO : strong.length > 0;
    return {
      level: dropshipping ? 'dropshipping' : 'resold',
      title: dropshipping ? 'Dropshipping probable' : `Article ${exact.platform} revendu`,
      lines: dedupe([...exactLines(exact, ratio), ...signalLines]),
      withoutImageSearch,
    };
  }

  const review =
    similar !== undefined ||
    strong.length > 0 ||
    weak.includes('price_above_similar') ||
    new Set(weak.map((id) => SIGNAL_FAMILY[id])).size >= REVIEW_MIN_WEAK_FAMILIES;
  if (review) {
    const lines = similar ? [`Photo ressemblante sur ${similar.platform}`] : [];
    return {
      level: 'review',
      title: 'À vérifier',
      lines: dedupe([...lines, ...signalLines]),
      withoutImageSearch,
    };
  }

  const reassurance = withoutImageSearch
    ? 'Photo non recherchée sur Shein, Temu…'
    : 'Aucune photo identique trouvée';
  return {
    level: 'clean',
    title: withoutImageSearch ? "Rien de suspect (sans recherche d'image)" : 'Rien de suspect',
    lines: dedupe([reassurance, ...signalLines]),
    withoutImageSearch,
  };
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)].slice(0, MAX_LINES);
}
