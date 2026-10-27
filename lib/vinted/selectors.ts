/**
 * Every Vinted DOM selector and URL pattern in one place.
 *
 * Only `data-testid` values and the unhashed `details-list--*` classes are used: the hashed
 * CSS class prefixes (`ymptpG_`, `web_ui__*`...) change between Vinted deploys.
 * See `.claude/work/vinted-recon.md` for how each one was verified.
 */

/** Item page path: `/items/<id>` or `/items/<id>-<slug>`. Group 1 is the item id. */
export const ITEM_PATH_PATTERN = /^\/items\/(\d+)(?:-[^/?#]*)?(?:[/?#]|$)/;

/** Seller link href: `/member/<id>` or `/member/<id>-<login>`. Group 1 is the seller id. */
export const MEMBER_PATH_PATTERN = /\/member\/(\d+)/;

/**
 * Root of a result card of the catalogue, the search and the seller's wardrobe:
 * `product-item-id-<id>` (its parts are `product-item-id-<id>--description`, `--image--img`...).
 * Group 1 is the item id. The parts share the prefix, so only an exact match is a card.
 */
export const PRODUCT_CARD_TESTID_PATTERN = /^product-item-id-(\d+)$/;

/** Root of a result card of the home feed; the item id is only in its link. */
export const FEED_CARD_TESTID = 'feed-item';

/** Photo testids: `item-photo-<N>` is the wrapper, `item-photo-<N>--img` the picture. */
export const PHOTO_IMG_TESTID_PATTERN = /^item-photo-(\d+)--img$/;

export const SELECTORS = {
  /** Machine-readable Product data (name, description, brand, price). */
  jsonLd: 'script[type="application/ld+json"]',
  /** Inline React Server Components chunks, the fallback data source. */
  rscScripts: 'script:not([src])',

  /** Wrapper around the base price and the price including fees. */
  priceBlock: '.details-list--pricing',
  priceContainer: '[data-testid="item-sidebar-price-container"]',
  /** Base price without fees, text like "4,50 €". */
  priceText: '[data-testid="item-price"]',
  /** Buy / offer / message button group. */
  actionsBlock: '.details-list--actions',

  /** Listing title (summary plugin, first heading) with a bare `h1` as last resort. */
  titleInSummary: '[data-testid="item-page-summary-plugin"] h1',
  titleHeading: 'h1',

  attributeSize: '[data-testid="item-attributes-size_familiar"]',
  attributeStatus: '[data-testid="item-attributes-status"]',
  /** Value element of an attribute row (the status one is `[itemprop="status"]`). */
  attributeItemprop: '[itemprop]',
  /** Generic value element of a `details-list` row, when the row has no `itemprop`. */
  attributeValue: '.details-list__item-value',

  /** Seller name; its parent `<a>` points to `/member/<id>`. */
  sellerName: '[data-testid="profile-username"]',
  sellerLink: 'a[href*="/member/"]',

  /** Every gallery testid; filter with `PHOTO_IMG_TESTID_PATTERN`. */
  galleryPhotos: '[data-testid^="item-photo-"]',
} as const;

/**
 * The result grids. A card is a root (`PRODUCT_CARD_TESTID_PATTERN` or `FEED_CARD_TESTID`) and its
 * parts are found by testid suffix inside it, so the catalogue and the home feed share them.
 */
export const GRID_SELECTORS = {
  /** Superset of the card roots: also matches their parts, filter with the two root testids. */
  cardCandidates: '[data-testid^="product-item-id-"], [data-testid="feed-item"]',
  /** Brand, size and price block: the Fripon button goes right after it. A card without it is not a whole card. */
  description: '[data-testid$="--description"]',
  title: '[data-testid$="--description-title"]',
  subtitle: '[data-testid$="--description-subtitle"]',
  price: '[data-testid$="--price-text"]',
  photo: '[data-testid$="--image--img"]',
  /** The link that covers the whole card. */
  overlayLink: '[data-testid$="--overlay-link"]',
  itemLink: 'a[href*="/items/"]',
} as const;

/** `data-testid`-based attribute row names, as found in the RSC `attributes[].code` field. */
export const ATTRIBUTE_CODES = {
  brand: 'brand',
  size: 'size_familiar',
  status: 'status',
} as const;
