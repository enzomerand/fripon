import type { Listing } from '../model';
import { parseCondition } from './condition';
import {
  ATTRIBUTE_CODES,
  ITEM_PATH_PATTERN,
  MEMBER_PATH_PATTERN,
  PHOTO_IMG_TESTID_PATTERN,
  SELECTORS,
} from './selectors';

type JsonObject = Record<string, unknown>;

const RSC_PUSH_PREFIX = 'self.__next_f.push(';

/** Currency symbols seen in Vinted price texts, used only when JSON-LD has no currency. */
const CURRENCY_BY_SYMBOL: ReadonlyArray<readonly [string, string]> = [
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['zł', 'PLN'],
  ['Kč', 'CZK'],
  ['Ft', 'HUF'],
  ['lei', 'RON'],
  ['$', 'USD'],
];

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

function elementText(element: Element | null): string | null {
  return element ? nonEmpty(element.textContent) : null;
}

function toNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** "4,50 €", "1 234,50 €", "1.234,50" or "4.5" to a number; null when there are no digits. */
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[^\d.,]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const parts = cleaned.split(/[.,]/);
  const last = parts[parts.length - 1] ?? '';
  const mixed = cleaned.includes(',') && cleaned.includes('.');
  // A lone separator followed by three digits (or repeated separators) groups thousands.
  const grouping = !mixed && (parts.length > 2 || last.length === 3);
  const normalized =
    parts.length === 1 || grouping ? parts.join('') : `${parts.slice(0, -1).join('')}.${last}`;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function currencyFromText(text: string | null): string | null {
  if (!text) return null;
  return CURRENCY_BY_SYMBOL.find(([symbol]) => text.includes(symbol))?.[1] ?? null;
}

/** Item id from an item page URL, null for any other page. */
export function itemIdFromUrl(url: string): string | null {
  try {
    return ITEM_PATH_PATTERN.exec(new URL(url).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function absoluteHttpUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw, base);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

// ---- JSON-LD ---------------------------------------------------------------------------------

function findProduct(data: unknown): JsonObject | null {
  if (Array.isArray(data)) {
    for (const entry of data) {
      const found = findProduct(entry);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(data)) return null;
  const type = data['@type'];
  if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return data;
  return findProduct(data['@graph']);
}

function readJsonLdProduct(doc: Document): JsonObject | null {
  for (const script of doc.querySelectorAll(SELECTORS.jsonLd)) {
    try {
      const product = findProduct(JSON.parse(script.textContent ?? ''));
      if (product) return product;
    } catch {
      // Malformed block: try the next one.
    }
  }
  return null;
}

function firstRecord(value: unknown): JsonObject | null {
  if (Array.isArray(value)) return value.find(isRecord) ?? null;
  return isRecord(value) ? value : null;
}

function jsonLdBrand(product: JsonObject): string | null {
  const brand = product.brand;
  return nonEmpty(brand) ?? (isRecord(brand) ? nonEmpty(brand.name) : null);
}

function jsonLdImages(product: JsonObject): string[] {
  const image = product.image;
  const entries = Array.isArray(image) ? image : [image];
  return entries
    .map((entry) => nonEmpty(entry) ?? (isRecord(entry) ? nonEmpty(entry.url) : null))
    .filter((entry): entry is string => entry !== null);
}

// ---- DOM -------------------------------------------------------------------------------------

/**
 * Text of an attribute row's value. The row glues its title to its value ("TailleM"), so look for
 * an explicit value element first, then take the last child of the innermost branching element.
 */
function attributeValue(row: Element | null): string | null {
  if (!row) return null;
  const explicit =
    row.querySelector(SELECTORS.attributeItemprop) ?? row.querySelector(SELECTORS.attributeValue);
  if (explicit) return elementText(explicit);
  let element: Element = row;
  while (element.children.length === 1 && element.firstElementChild) {
    element = element.firstElementChild;
  }
  const last = element.lastElementChild;
  return element.children.length >= 2 && last ? elementText(last) : elementText(element);
}

function domSellerId(doc: Document): string | null {
  const href = doc
    .querySelector(SELECTORS.sellerName)
    ?.closest(SELECTORS.sellerLink)
    ?.getAttribute('href');
  return href ? (MEMBER_PATH_PATTERN.exec(href)?.[1] ?? null) : null;
}

function domPhotos(doc: Document, base: string): string[] {
  const photos: Array<{ order: number; url: string }> = [];
  for (const element of doc.querySelectorAll(SELECTORS.galleryPhotos)) {
    const match = PHOTO_IMG_TESTID_PATTERN.exec(element.getAttribute('data-testid') ?? '');
    if (!match) continue;
    const img = element.tagName === 'IMG' ? element : element.querySelector('img');
    const url = absoluteHttpUrl(img?.getAttribute('src') || img?.getAttribute('data-src'), base);
    if (url) photos.push({ order: Number(match[1]), url });
  }
  photos.sort((a, b) => a.order - b.order);
  return [...new Set(photos.map((photo) => photo.url))];
}

// ---- RSC fallback ----------------------------------------------------------------------------

interface RscAttribute {
  value: string | null;
  id: number | string | null;
}

interface RscData {
  sellerId: string | null;
  photos: string[];
  attributes: Map<string, RscAttribute>;
}

const rscCache = new WeakMap<Document, { scriptCount: number; text: string }>();

/** The concatenated payload of every `self.__next_f.push([1, "..."])` inline script. */
function rscText(doc: Document): string {
  const scripts = [...doc.querySelectorAll(SELECTORS.rscScripts)].filter((script) =>
    script.textContent?.startsWith(RSC_PUSH_PREFIX),
  );
  const cached = rscCache.get(doc);
  if (cached && cached.scriptCount === scripts.length) return cached.text;

  let text = '';
  for (const script of scripts) {
    const content = script.textContent ?? '';
    try {
      const args: unknown = JSON.parse(
        content.slice(RSC_PUSH_PREFIX.length, content.lastIndexOf(')')),
      );
      if (Array.isArray(args) && args[0] === 1 && typeof args[1] === 'string') text += args[1];
    } catch {
      // Not a flight chunk we understand: skip it.
    }
  }
  rscCache.set(doc, { scriptCount: scripts.length, text });
  return text;
}

/** Index just after the object / array that starts at `start`, -1 when unbalanced. */
function endOfJsonValue(text: string, start: number): number {
  const open = text[start];
  if (open !== '{' && open !== '[') return -1;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Every object / array value that follows `"<key>":` in the payload, in order of appearance. */
function* jsonValuesForKey(text: string, key: string): Generator<unknown> {
  const needle = `"${key}":`;
  let from = text.indexOf(needle);
  while (from >= 0) {
    const start = from + needle.length;
    const end = endOfJsonValue(text, start);
    let value: unknown;
    if (end > 0) {
      try {
        value = JSON.parse(text.slice(start, end));
      } catch {
        value = undefined;
      }
    }
    if (value !== undefined) yield value;
    from = text.indexOf(needle, start);
  }
}

function rscPhotos(text: string): string[] {
  for (const value of jsonValuesForKey(text, 'photos')) {
    if (!Array.isArray(value)) continue;
    const photos = value.filter(isRecord).filter((photo) => nonEmpty(photo.url) !== null);
    if (photos.length === 0) continue;
    // The main photo comes first, the others keep their order.
    const ordered = [
      ...photos.filter((p) => p.is_main === true),
      ...photos.filter((p) => p.is_main !== true),
    ];
    return [
      ...new Set(
        ordered.map((photo) => nonEmpty(photo.url)).filter((u): u is string => u !== null),
      ),
    ];
  }
  return [];
}

function rscAttributes(text: string): Map<string, RscAttribute> {
  const known = new Set<string>(Object.values(ATTRIBUTE_CODES));
  for (const value of jsonValuesForKey(text, 'attributes')) {
    if (!Array.isArray(value)) continue;
    const rows = value.filter(isRecord).filter((row) => typeof row.code === 'string');
    if (!rows.some((row) => known.has(row.code as string))) continue;
    const attributes = new Map<string, RscAttribute>();
    for (const row of rows) {
      const data = isRecord(row.data) ? row.data : {};
      const id = typeof data.id === 'number' || typeof data.id === 'string' ? data.id : null;
      attributes.set(row.code as string, {
        value: nonEmpty(data.value) ?? nonEmpty(data.title),
        id,
      });
    }
    return attributes;
  }
  return new Map();
}

function rscSellerId(text: string, itemId: string): string | null {
  const props = new RegExp(`"itemId":"?${itemId}"?,"sellerId":"?(\\d+)`).exec(text);
  return props?.[1] ?? /"seller_id":"?(\d+)"?/.exec(text)?.[1] ?? null;
}

function readRsc(doc: Document, itemId: string): RscData {
  const text = rscText(doc);
  return {
    sellerId: rscSellerId(text, itemId),
    photos: rscPhotos(text),
    attributes: rscAttributes(text),
  };
}

// ---- Reader ----------------------------------------------------------------------------------

/**
 * Builds a `Listing` from an item page: JSON-LD for title / description / brand / price, the
 * attribute rows and seller link of the DOM for the rest, and the React Server Components
 * payload only when something is missing. Returns null when the page is not an item page or an
 * essential field (title, price, seller) is not there yet, so callers can retry while the
 * page streams in.
 */
export function readListing(doc: Document, url: string): Listing | null {
  const id = itemIdFromUrl(url);
  if (!id) return null;

  const product = readJsonLdProduct(doc);
  const offers = product ? firstRecord(product.offers) : null;

  let rscData: RscData | undefined;
  const rsc = (): RscData => (rscData ??= readRsc(doc, id));

  const title =
    nonEmpty(product?.name) ??
    elementText(doc.querySelector(SELECTORS.titleInSummary)) ??
    elementText(doc.querySelector(SELECTORS.titleHeading));
  const priceText = elementText(doc.querySelector(SELECTORS.priceText));
  const amount = toNumber(offers?.price) ?? (priceText ? parseAmount(priceText) : null);
  const currency = nonEmpty(offers?.priceCurrency) ?? currencyFromText(priceText);
  const sellerId = domSellerId(doc) ?? rsc().sellerId;
  if (!title || amount === null || !currency || !sellerId) return null;

  const statusRow = doc.querySelector(SELECTORS.attributeStatus);
  let condition = parseCondition({ label: attributeValue(statusRow) });
  if (condition === 'unknown') {
    const status = rsc().attributes.get(ATTRIBUTE_CODES.status);
    condition = parseCondition({ statusId: status?.id, label: status?.value });
  }

  const size =
    attributeValue(doc.querySelector(SELECTORS.attributeSize)) ??
    rsc().attributes.get(ATTRIBUTE_CODES.size)?.value ??
    null;
  const brand = product
    ? jsonLdBrand(product)
    : (rsc().attributes.get(ATTRIBUTE_CODES.brand)?.value ?? null);

  let photoUrls = domPhotos(doc, url);
  if (photoUrls.length === 0) photoUrls = rsc().photos;
  if (photoUrls.length === 0 && product) photoUrls = jsonLdImages(product);
  photoUrls = photoUrls.flatMap((photo) => absoluteHttpUrl(photo, url) ?? []);

  return {
    id,
    url,
    title,
    description: typeof product?.description === 'string' ? product.description.trim() : '',
    price: { amount, currency },
    brand,
    size,
    condition,
    photoUrls,
    sellerId,
  };
}
