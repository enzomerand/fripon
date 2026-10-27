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
  /** The block of the card's text that ends with the price: the button goes right after it. */
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
 * Where the Fripon block goes in a card: right after the block that ends the card's text, so below
 * the title, the size AND the price (and the fees line under it), never between them. The card's
 * text is a column (`--description`, then the price, then `--breakdown`, in a `--summary`): the
 * block is the child of the column that holds the end of the price, so it sits at the level of its
 * siblings and takes the full width, however deep the price is wrapped.
 *
 * Without a price in the card, or when it is not below the description, the description itself.
 * Null without a description: not a whole card.
 */
export function findButtonAnchor(root: Element): Element | null {
  const description = root.querySelector(GRID_SELECTORS.description);
  if (!description) return null;
  const priceEnd =
    root.querySelector(GRID_SELECTORS.breakdown) ?? root.querySelector(GRID_SELECTORS.price);
  if (!priceEnd || description.contains(priceEnd)) return description;

  // The column that holds both the description and the price: the lowest common ancestor.
  let column = description.parentElement;
  while (column && !column.contains(priceEnd)) column = column.parentElement;
  if (!column) return description;
  let block: Element = priceEnd;
  while (block.parentElement && block.parentElement !== column) block = block.parentElement;
  if (block.parentElement !== column) return description;

  // A price that sits above the description is not what this is made for.
  const below =
    block.contains(description) ||
    description.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING;
  return below ? block : description;
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

  const anchor = findButtonAnchor(element);
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

/** Containers the bar must not be put before: it would end up outside the results. */
const PAGE_CONTAINERS: ReadonlySet<string> = new Set(['HTML', 'BODY', 'MAIN']);

const isPageContainer = (element: Element) =>
  PAGE_CONTAINERS.has(element.tagName) || element.getAttribute('role') === 'main';

/**
 * The element the bar above the results goes before: the first container that holds every card,
 * the grid itself. When that is the whole page (the home feed has its cards in several blocks), the
 * block of the page that holds the first card instead. Null without any card.
 */
export function findResultsAnchor(cards: readonly Element[]): Element | null {
  const first = cards[0];
  if (!first) return null;
  // A lone card has only its own cell around it: the grid is one level up.
  let container = first.parentElement;
  if (cards.length === 1 && container?.parentElement) container = container.parentElement;
  while (container && !cards.every((card) => container?.contains(card))) {
    container = container.parentElement;
  }
  if (!container) return null;
  if (!isPageContainer(container)) return container;
  let block: Element = first;
  while (block.parentElement && block.parentElement !== container) block = block.parentElement;
  return block;
}
