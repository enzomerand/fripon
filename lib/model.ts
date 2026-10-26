/** Shared data model. Vinted readers produce these; checks and the verdict engine consume them. */

export interface Money {
  amount: number;
  /** ISO 4217 code, e.g. "EUR", "PLN", "GBP". */
  currency: string;
}

export type Condition =
  'new_with_tags' | 'new_without_tags' | 'very_good' | 'good' | 'satisfactory' | 'unknown';

export interface Listing {
  id: string;
  url: string;
  title: string;
  description: string;
  price: Money;
  /**
   * null when the listing has no brand or uses a "no brand" placeholder; undefined when the brand
   * could not be read from the page (then no check may conclude "no brand").
   */
  brand?: string | null;
  size: string | null;
  condition: Condition;
  /** Full-size photo URLs, main photo first. */
  photoUrls: string[];
  sellerId: string;
}

export interface SellerItem {
  id: string;
  title: string;
  condition: Condition;
  size: string | null;
  /** null when the item has no brand (or the API did not give one). */
  brand: string | null;
  photoUrl: string | null;
}

export interface Seller {
  id: string;
  /** Number of reviews, null when Vinted did not give it (then no review-based signal). */
  feedbackCount: number | null;
  /** Total active listings of the seller. */
  itemCount: number;
  /** Sample of the seller's active listings (first wardrobe page). */
  items: SellerItem[];
}

export type CheckId = 'image' | 'price' | 'seller' | 'photos' | 'description';

/** ok = green, warn = orange, bad = red, off = not run (no key, quota reached, unsupported). */
export type CheckStatus = 'ok' | 'warn' | 'bad' | 'off';

export type SignalId =
  | 'stock_multiple_sizes'
  | 'mostly_new_with_tags'
  | 'few_reviews'
  | 'catalog_photo'
  | 'photo_reused'
  | 'marketplace_style_text'
  | 'no_brand'
  | 'price_above_similar';

export interface Signal {
  id: SignalId;
  strength: 'strong' | 'weak';
}

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  /** Short French tag shown on the right of the check row, e.g. "Photo catalogue". */
  tag: string;
  /** One French sentence explaining the result. */
  detail: string;
  signals: Signal[];
  /** A button the card shows under the detail, when there is something the user can do about it. */
  action?: CheckAction;
  /** Image row only: where the photo was found, exact matches first (the card links to them). */
  matches?: ImageMatch[];
}

/**
 * open_guide: the setup guide. open_settings: the credits section of the options page.
 * open_keys: the keys section of the options page. run_image_search: the "Au clic" button, which
 * runs the image search from the card itself.
 */
export type CheckAction = 'open_guide' | 'open_settings' | 'open_keys' | 'run_image_search';

/** One page where the reverse image search found the listing photo. */
export interface ImageMatch {
  /** Display name, e.g. "Shein". */
  platform: string;
  url: string;
  /** true only for a full image match on a product page. */
  exact: boolean;
  price: Money | null;
}

export type VerdictLevel = 'dropshipping' | 'resold' | 'review' | 'clean';

export interface Verdict {
  level: VerdictLevel;
  /** French title, e.g. "Dropshipping probable". */
  title: string;
  /** One or two short French lines for the collapsed card. */
  lines: string[];
  /** true when the image search did not run, so a green verdict must say so. */
  withoutImageSearch: boolean;
}
