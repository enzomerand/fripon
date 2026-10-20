import { accountAgeDays, formatAccountAge } from '../format';
import type { CheckResult, Seller, SellerItem, Signal } from '../model';

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
/** Titles shorter than this (in words, once sizes are stripped) are too generic to compare ("Robe"). */
export const STOCK_MIN_TITLE_WORDS = 2;

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

/** true when the sample holds the same article in several sizes, or many copies of it. */
export function hasStockPattern(items: SellerItem[]): boolean {
  const groups = new Map<string, SellerItem[]>();
  for (const item of items) {
    const key = normalizeTitle(item.title, item.size);
    if (key.split(' ').filter(Boolean).length < STOCK_MIN_TITLE_WORDS) continue;
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
    if (sizes.size >= STOCK_MIN_DISTINCT_SIZES || group.length >= STOCK_MIN_COPIES) return true;
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
): string {
  const parts: string[] = [];

  const registered = formatAccountAge(seller.createdAt, now);
  const reviews = seller.feedbackCount === 0 ? 'aucun avis' : `${seller.feedbackCount} avis`;
  const profile = [registered && `Inscrit ${registered}`, reviews].filter(Boolean).join(', ');
  parts.push(`${profile.charAt(0).toUpperCase()}${profile.slice(1)}.`);

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

  return parts.join(' ');
}

export function checkSeller(seller: Seller, now: Date): CheckResult {
  const signals: Signal[] = [];

  const ageDays = accountAgeDays(seller.createdAt, now);
  if (ageDays !== null && ageDays < NEW_ACCOUNT_DAYS) {
    signals.push({ id: 'new_account', strength: 'weak' });
  }
  if (seller.feedbackCount < FEW_REVIEWS) {
    signals.push({ id: 'few_reviews', strength: 'weak' });
  }

  const sampleSize = seller.items.length;
  const newWithTags = seller.items.filter((i) => i.condition === 'new_with_tags').length;
  if (sampleSize >= MIN_SAMPLE_FOR_NEW_SHARE && newWithTags / sampleSize >= NEW_WITH_TAGS_SHARE) {
    signals.push({ id: 'mostly_new_with_tags', strength: 'strong' });
  }

  const stock = hasStockPattern(seller.items);
  if (stock) signals.push({ id: 'stock_multiple_sizes', strength: 'strong' });

  const status = signals.some((s) => s.strength === 'strong')
    ? 'bad'
    : signals.length > 0
      ? 'warn'
      : 'ok';

  return {
    id: 'seller',
    status,
    tag: status === 'ok' ? 'Rassurant' : 'À surveiller',
    detail: buildDetail(
      seller,
      now,
      newWithTags,
      Math.max(seller.itemCount, sampleSize),
      sampleSize,
      stock,
    ),
    signals,
  };
}
