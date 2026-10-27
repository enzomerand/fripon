import {
  FEED_CARD_TESTID,
  GRID_SELECTORS,
  ITEM_PATH_PATTERN,
  PRODUCT_CARD_TESTID_PATTERN,
} from './selectors';

/** One result card of a grid (catalogue, search, seller's wardrobe, home feed), read from the page. */
export interface GridCard {
  /** Vinted item id. */
  id: string;
  /** Absolute URL of the item page. */
  url: string;
  /** The thumbnail to search, null when the card only has a placeholder or a tiny picture. */
  photoUrl: string | null;
  /** The brand line of the card ("Shein"), '' when it has none. */
  title: string;
  /** Size and condition ("M · Très bon état"). */
  subtitle: string;
  /** The price as shown, without fees ("12,00 €"). */
  priceText: string;
  /** The card's root element. */
  element: Element;
  /** The description block (title, size, price): the button goes right after it. */
  anchor: Element;
}

/** Longest side, in px, up to which a Vinted thumbnail (`/100x100/`, `/70x100/`) is too small to search. */
const TINY_THUMBNAIL_MAX_SIDE = 100;

const SIZE_SEGMENT_PATTERN = /^(\d+)x(\d+)$/;

const squash = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

function isVintedImageHost(host: string): boolean {
  return host === 'vinted.net' || host.endsWith('.vinted.net');
}

function isTinyThumbnail(pathname: string): boolean {
  return pathname.split('/').some((segment) => {
    const size = SIZE_SEGMENT_PATTERN.exec(segment);
    return size !== null && Math.max(Number(size[1]), Number(size[2])) <= TINY_THUMBNAIL_MAX_SIDE;
  });
}

/**
 * The first usable photo among `candidates` (the picture's `currentSrc`, then its `src`): an
 * https address on Vinted's image CDN that is not a tiny thumbnail. A lazy-loading placeholder
 * (`data:` URI, blank gif) or a 100x100 picture is skipped, and so is anything that is not a URL.
 */
export function pickPhotoUrl(candidates: ReadonlyArray<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'https:' || !isVintedImageHost(url.hostname)) continue;
      if (isTinyThumbnail(url.pathname)) continue;
      return url.href;
    } catch {
      // Not a URL (empty, relative, malformed): nothing to search.
    }
  }
  return null;
}

/** Id and absolute URL of the item a link points to, null for any other link. */
function parseItemLink(href: string | null, base: string): { id: string; url: string } | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    const id = ITEM_PATH_PATTERN.exec(url.pathname)?.[1];
    return id ? { id, url: url.href } : null;
  } catch {
    return null;
  }
}

function itemLinkOf(element: Element, base: string) {
  const overlay = parseItemLink(
    element.querySelector(GRID_SELECTORS.overlayLink)?.getAttribute('href') ?? null,
    base,
  );
  if (overlay) return overlay;
  for (const link of element.querySelectorAll(GRID_SELECTORS.itemLink)) {
    const parsed = parseItemLink(link.getAttribute('href'), base);
    if (parsed) return parsed;
  }
  return null;
}

/** Whether `element` is the root of a result card (and not one of its parts, which share the prefix). */
function isCardRoot(element: Element): boolean {
  const testid = element.getAttribute('data-testid') ?? '';
  return PRODUCT_CARD_TESTID_PATTERN.test(testid) || testid === FEED_CARD_TESTID;
}

/** The root elements of the result cards under `root`, in page order: whole cards or not. */
export function findCardRoots(root: ParentNode): Element[] {
  return [...root.querySelectorAll(GRID_SELECTORS.cardCandidates)].filter(isCardRoot);
}

/**
 * Reads one card from its root element. Null when `element` is not a whole card: a part of a card
 * (the image, the link...), a card without its description block (a promotion, a card still being
 * drawn), or a card whose item cannot be told.
 */
export function readGridCard(element: Element): GridCard | null {
  if (!isCardRoot(element)) return null;
  const idFromTestid = PRODUCT_CARD_TESTID_PATTERN.exec(
    element.getAttribute('data-testid') ?? '',
  )?.[1];

  const anchor = element.querySelector(GRID_SELECTORS.description);
  if (!anchor) return null;

  const base = element.ownerDocument.baseURI;
  const link = itemLinkOf(element, base);
  const id = idFromTestid ?? link?.id;
  if (!id) return null;

  // Not narrowed with `instanceof`: a content script and the page do not share their prototypes.
  const image = element.querySelector<HTMLImageElement>(GRID_SELECTORS.photo);

  return {
    id,
    // The testid is the id of the card; the link has the slug. Without a link, Vinted redirects
    // the bare `/items/<id>` to the right page.
    url: link?.id === id ? link.url : new URL(`/items/${id}`, base).href,
    photoUrl: pickPhotoUrl([image?.currentSrc, image?.src]),
    title: squash(element.querySelector(GRID_SELECTORS.title)?.textContent),
    subtitle: squash(element.querySelector(GRID_SELECTORS.subtitle)?.textContent),
    priceText: squash(element.querySelector(GRID_SELECTORS.price)?.textContent),
    element,
    anchor,
  };
}

/** Every whole result card under `root`, in page order. */
export function readGridCards(root: ParentNode): GridCard[] {
  const cards: GridCard[] = [];
  for (const element of findCardRoots(root)) {
    const card = readGridCard(element);
    if (card) cards.push(card);
  }
  return cards;
}
