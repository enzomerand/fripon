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
  price: Money;
  photoUrl: string | null;
}

export interface Seller {
  id: string;
  login: string;
  /** ISO date of account creation, null when Vinted does not expose it. */
  createdAt: string | null;
  feedbackCount: number;
  /** 0..5, null when unknown. */
  rating: number | null;
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
  | 'new_account'
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
}

/** Result of the reverse image search (filled from lot 3 on). */
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
