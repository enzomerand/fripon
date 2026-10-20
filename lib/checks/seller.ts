import { accountAgeDays, formatAccountAge } from '../format';
import { hammingDistance } from '../image/pixels';
import type { CheckResult, Seller, SellerItem, Signal } from '../model';
import { isNoBrand } from './description';
import { isInformativeHash } from './photos';

/** An account younger than this many days is a weak signal. */
export const NEW_ACCOUNT_DAYS = 60;
/** Fewer reviews than this is a weak signal. */
export const FEW_REVIEWS = 5;
/** Minimum sample size before the share of "new with tags" items means anything. */
export const MIN_SAMPLE_FOR_NEW_SHARE = 10;
/** Share of "new with tags" items in the sample above which the wardrobe looks like stock. */
export const NEW_WITH_TAGS_SHARE = 0.6;
/** The same article listed in at least this many distinct sizes is stock, not a wardrobe. */
export const STOCK_MIN_DISTINCT_SIZES = 2;
/** The same article listed at least this many times is stock, whatever the sizes. */
export const STOCK_MIN_COPIES = 3;
/**
 * Titles with fewer meaningful words than this (sizes, numbers and small words left out) are too
 * generic to compare: "Robe fleurie" or "Jean slim" are in everyone's wardrobe.
 */
export const STOCK_MIN_TITLE_WORDS = 3;
/** Main photos of two copies whose hashes differ by at most this many bits are the same picture. */
export const STOCK_PHOTO_MAX_DISTANCE = 3;
/** Above this share of items with an unknown condition, the wardrobe analysis is flagged as partial. */
export const UNKNOWN_CONDITION_MAX_SHARE = 0.5;

/** Function words that do not make a title specific. */
const TITLE_STOPWORDS = new Set(
  'de du des la le les un une et en au aux pour avec sans the of and for with in on a an'.split(
    ' ',
  ),
);

/** Main photo hash of a seller's item, as computed for the photos check. */
export interface ItemPhotoHash {
  itemId: string;
  hash: bigint;
}

const SIZE_TOKEN = '(?:[2-5]?x{0,3}s|[2-5]?x{0,3}l|m|\\d{2}(?:/\\d{2})?)';
/** "taille M", "size 38", "T.38", "t38". */
const SIZE_PHRASE = new RegExp(
  `\\b(?:taille|size|sz|t\\.?)\\s*[:.]?\\s*${SIZE_TOKEN}(?![a-z0-9])`,
  'g',
);
/** A lone letter size: "S", "XL", "2XL". Numbers are kept ("Air Max 90"). */
const LONE_LETTER_SIZE = /\b(?:[2-5]?x{0,3}s|[2-5]?x{0,3}l|m)\b/g;

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lowercase, accent-free, size-free title used to spot the same article across sizes. */
export function normalizeTitle(title: string, size: string | null): string {
  let t = stripAccents(title.toLowerCase());
  t = t.replace(SIZE_PHRASE, ' ');
  if (size) {
    const own = stripAccents(size.toLowerCase()).trim();
    if (own) t = t.replace(new RegExp(`(?<![a-z0-9])${escapeRegExp(own)}(?![a-z0-9])`, 'g'), ' ');
  }
  t = t.replace(LONE_LETTER_SIZE, ' ');
  return t
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSize(size: string | null): string | null {
  const s = size ? stripAccents(size.toLowerCase()).replace(/\s+/g, '') : '';
  return s || null;
}

function meaningfulWords(normalizedTitle: string): number {
  return normalizedTitle
    .split(' ')
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !TITLE_STOPWORDS.has(word)).length;
}

function normalizeBrand(brand: string | null): string | null {
  if (brand === null || isNoBrand(brand)) return null;
  return stripAccents(brand.toLowerCase()).replace(/\s+/g, ' ').trim() || null;
}

/** At least two copies carry the same real brand ("Sans marque" is not one). */
function sharesBrand(group: SellerItem[]): boolean {
  const counts = new Map<string, number>();
  for (const item of group) {
    const brand = normalizeBrand(item.brand);
    if (brand) counts.set(brand, (counts.get(brand) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values()) >= 2;
}

/** At least two copies have a near-identical main photo (hashes known and informative only). */
function sharesPhoto(group: SellerItem[], hashes: ItemPhotoHash[]): boolean {
  const byItem = new Map(
    hashes.filter((entry) => isInformativeHash(entry.hash)).map((e) => [e.itemId, e.hash]),
  );
  const known = group.flatMap((item) => byItem.get(item.id) ?? []);
  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      if (hammingDistance(known[i] as bigint, known[j] as bigint) <= STOCK_PHOTO_MAX_DISTANCE) {
        return true;
      }
    }
  }
  return false;
}

/**
 * true when the sample holds the same article in several sizes, or many copies of it, AND the
 * copies look like one product: same real brand, or near-identical photos. A seller who owns
 * "Robe fleurie" in two sizes (a sister, a mother) is not stock.
 */
export function hasStockPattern(items: SellerItem[], hashes: ItemPhotoHash[] = []): boolean {
  const groups = new Map<string, SellerItem[]>();
  for (const item of items) {
    const key = normalizeTitle(item.title, item.size);
    if (meaningfulWords(key) < STOCK_MIN_TITLE_WORDS) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const group of groups.values()) {
    const sizes = new Set<string>();
    for (const item of group) {
      const size = normalizeSize(item.size);
      if (size) sizes.add(size);
    }
    const repeated = sizes.size >= STOCK_MIN_DISTINCT_SIZES || group.length >= STOCK_MIN_COPIES;
    if (repeated && (sharesBrand(group) || sharesPhoto(group, hashes))) return true;
  }
  return false;
}

function buildDetail(
  seller: Seller,
  now: Date,
  newWithTags: number,
  articleCount: number,
  sampleSize: number,
  stock: boolean,
  conditionsUnknown: boolean,
): string {
  const parts: string[] = [];

  const registered = formatAccountAge(seller.createdAt, now);
  // A missing review count is not "no review": say nothing rather than something wrong.
  const reviews =
    seller.feedbackCount === null
      ? ''
      : seller.feedbackCount === 0
        ? 'aucun avis'
        : `${seller.feedbackCount} avis`;
  const profile = [registered && `Inscrit ${registered}`, reviews].filter(Boolean).join(', ');
  if (profile) parts.push(`${profile.charAt(0).toUpperCase()}${profile.slice(1)}.`);

  if (articleCount === 0) {
    parts.push('Aucun article en vente.');
  } else {
    let line = `${articleCount} article${articleCount === 1 ? '' : 's'} en vente`;
    if (newWithTags > 0) {
      const label = `« neuf${newWithTags === 1 ? '' : 's'} avec étiquette »`;
      // The sample can be smaller than the whole wardrobe: then only the share is reliable.
      line +=
        sampleSize >= articleCount
          ? ` dont ${newWithTags} ${label}`
          : ` dont environ ${Math.round((newWithTags / sampleSize) * 100)} % ${label}`;
    }
    if (stock) line += ', souvent en plusieurs tailles';
    parts.push(`${line}.`);
  }
  if (conditionsUnknown) parts.push('État des articles non analysé.');

  return parts.join(' ');
}

/**
 * @param photoHashes main-photo hashes of the seller's items, when already computed: they let
 *   the stock pattern be confirmed by near-identical photos.
 */
export function checkSeller(
  seller: Seller,
  now: Date,
  photoHashes: ItemPhotoHash[] = [],
): CheckResult {
  const signals: Signal[] = [];

  const ageDays = accountAgeDays(seller.createdAt, now);
  if (ageDays !== null && ageDays < NEW_ACCOUNT_DAYS) {
    signals.push({ id: 'new_account', strength: 'weak' });
  }
  if (seller.feedbackCount !== null && seller.feedbackCount < FEW_REVIEWS) {
    signals.push({ id: 'few_reviews', strength: 'weak' });
  }

  const sampleSize = seller.items.length;
  // If Vinted changed how conditions are labelled, "not many new items" means nothing.
  const unknownConditions = seller.items.filter((i) => i.condition === 'unknown').length;
  const conditionsUnknown =
    sampleSize > 0 && unknownConditions / sampleSize > UNKNOWN_CONDITION_MAX_SHARE;
  const newWithTags = seller.items.filter((i) => i.condition === 'new_with_tags').length;
  if (sampleSize >= MIN_SAMPLE_FOR_NEW_SHARE && newWithTags / sampleSize >= NEW_WITH_TAGS_SHARE) {
    signals.push({ id: 'mostly_new_with_tags', strength: 'strong' });
  }

  const stock = hasStockPattern(seller.items, photoHashes);
  if (stock) signals.push({ id: 'stock_multiple_sizes', strength: 'strong' });

  const status = signals.some((s) => s.strength === 'strong')
    ? 'bad'
    : signals.length > 0
      ? 'warn'
      : 'ok';

  return {
    id: 'seller',
    status,
    tag: status !== 'ok' ? 'À surveiller' : conditionsUnknown ? "Peu d'infos" : 'Rassurant',
    detail: buildDetail(
      seller,
      now,
      newWithTags,
      Math.max(seller.itemCount, sampleSize),
      sampleSize,
      stock,
      conditionsUnknown,
    ),
    signals,
  };
}
