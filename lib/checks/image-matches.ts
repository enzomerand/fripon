import type { WebDetection, WebPage } from '../google/vision';
import type { ImageMatch } from '../model';

/** At most this many matches are kept (exact ones first). */
export const MAX_IMAGE_MATCHES = 10;

interface Platform {
  /** Display name, e.g. "Shein". */
  name: string;
  /** The registrable label of its domains: `shein` in `fr.shein.com` and `shein.co.uk`. */
  label: string;
  /** What a product page looks like, tested on the URL path. Category pages do not match. */
  product: RegExp;
}

/** The sites a dropshipped photo comes from. Everything else Google finds is ignored. */
export const PLATFORMS: readonly Platform[] = [
  { name: 'Shein', label: 'shein', product: /-p-\d+/ },
  { name: 'Romwe', label: 'romwe', product: /-p-\d+/ },
  { name: 'Temu', label: 'temu', product: /-g-\d+\.html|\/goods\.html/ },
  { name: 'AliExpress', label: 'aliexpress', product: /\/item\/\d+/ },
  { name: 'Alibaba', label: 'alibaba', product: /\/product-detail\// },
  { name: 'DHgate', label: 'dhgate', product: /\/product\// },
  { name: 'Wish', label: 'wish', product: /\/product\// },
  { name: 'Zaful', label: 'zaful', product: /-p_\d+/ },
  { name: 'Banggood', label: 'banggood', product: /-p-\d+/ },
];

/** Second-level labels under a country code: `co.uk`, `com.au`, `com.mx`... */
const SECOND_LEVEL_LABELS: ReadonlySet<string> = new Set([
  'co',
  'com',
  'org',
  'net',
  'ac',
  'or',
  'ne',
  'gov',
  'edu',
]);

const GENERIC_TLDS: ReadonlySet<string> = new Set(['com', 'net', 'org']);

/**
 * Whether these trailing labels are a top-level domain: `com`, a two-letter country code, or a
 * second level under a country code (`co.uk`). Cheap TLDs such as `.shop` or `.top` are left out
 * on purpose: a lookalike store is the most likely thing to live there.
 */
function isTld(labels: readonly string[]): boolean {
  const [first, second] = labels;
  if (first === undefined) return false;
  if (labels.length === 1) return GENERIC_TLDS.has(first) || /^[a-z]{2}$/.test(first);
  return (
    labels.length === 2 &&
    SECOND_LEVEL_LABELS.has(first) &&
    second !== undefined &&
    /^[a-z]{2}$/.test(second)
  );
}

/**
 * The platform a host belongs to. Its name must be the registrable label, followed by nothing but
 * the TLD: `fr.shein.com`, `m.shein.com` and `shein.co.uk` are Shein; `shein.someblog.com`
 * (a blog), `wishlist.com` and `notshein.com` are not.
 */
export function platformOfHost(hostname: string): Platform | undefined {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  // `co.uk` first: with a single-label tail, `shein.co.uk` would read as the label `co`.
  for (const tldLength of [2, 1]) {
    if (labels.length <= tldLength || !isTld(labels.slice(-tldLength))) continue;
    const registrable = labels[labels.length - tldLength - 1];
    const platform = PLATFORMS.find((p) => p.label === registrable);
    if (platform) return platform;
  }
  return undefined;
}

function hasFullMatch(page: WebPage): boolean {
  return (page.fullMatchingImages ?? []).length > 0;
}

/**
 * Turns what Vision found into the matches Fripon cares about: pages of the listed platforms.
 * A match is `exact` when Google found the whole photo on a product page; a platform page that
 * only shares part of it, or a category page, is a similar match. Vinted, second-hand sites,
 * blogs and social networks are ignored. Duplicated URLs are merged, exact matches come first,
 * and `price` is left for the price comparison to fill.
 */
export function parseWebDetection(webDetection: WebDetection): ImageMatch[] {
  const byUrl = new Map<string, ImageMatch>();
  for (const page of webDetection.pagesWithMatchingImages ?? []) {
    if (typeof page.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(page.url);
    } catch {
      continue;
    }
    // The link ends up in the card: no javascript:, data: or other scheme.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const platform = platformOfHost(url.hostname);
    if (!platform) continue;

    url.hash = '';
    const exact = hasFullMatch(page) && platform.product.test(url.pathname);
    const known = byUrl.get(url.href);
    if (known) known.exact ||= exact;
    else byUrl.set(url.href, { platform: platform.name, url: url.href, exact, price: null });
  }

  const matches = [...byUrl.values()];
  // Array#sort is stable: the order of Google's answer is kept inside each group.
  return matches.sort((a, b) => Number(b.exact) - Number(a.exact)).slice(0, MAX_IMAGE_MATCHES);
}
