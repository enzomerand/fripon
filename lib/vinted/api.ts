import { browser, type Browser } from 'wxt/browser';
import type { Money, Seller, SellerItem } from '../model';
import { parseCondition } from './condition';

/** Minimum delay between two Vinted API requests (DataDome / Cloudflare sit in front of `/api`). */
export const MIN_REQUEST_SPACING_MS = 1_500;
/** A cached seller is reused for this long before being fetched again. */
export const SELLER_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
/** At most this many sellers are kept in `storage.local`, the oldest dropped first. */
export const SELLER_CACHE_MAX_ENTRIES = 50;
/** Wardrobe page size: the largest the endpoint accepts, so one call covers most sellers. */
export const WARDROBE_PER_PAGE = 96;
/** Prefix of the `storage.local` keys holding cached sellers. */
export const SELLER_CACHE_KEY_PREFIX = 'fripon:seller:';

export type VintedApiErrorCode =
  /** The id is not a numeric Vinted user id; nothing was sent. */
  | 'invalid_request'
  /** 403: Cloudflare / DataDome challenge. */
  | 'blocked'
  /** 429: too many requests. */
  | 'rate_limited'
  | 'not_found'
  /** Any other non-2xx status. */
  | 'http'
  /** The request itself failed (offline, extension context gone...). */
  | 'network'
  /** 2xx, but the body is not the JSON shape we expect. */
  | 'invalid_response';

export class VintedApiError extends Error {
  readonly code: VintedApiErrorCode;
  readonly status: number | undefined;

  constructor(code: VintedApiErrorCode, message: string, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'VintedApiError';
    this.code = code;
    this.status = status;
  }
}

// ---- Request queue ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Runs tasks one at a time, starting each at least `spacingMs` after the previous one started. */
export class RequestQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly spacingMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.lastStart + this.spacingMs - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      this.lastStart = this.clock.now();
      return task();
    });
    // A failed task must not block the ones behind it.
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** The one queue shared by every Vinted API call of this page. */
const sharedQueue = new RequestQueue(MIN_REQUEST_SPACING_MS);

// ---- Dependencies ----------------------------------------------------------------------------

export interface ApiDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  queue: RequestQueue;
  now: () => number;
  storage: Pick<Browser.storage.StorageArea, 'get' | 'set' | 'remove'>;
}

function defaultDeps(): ApiDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    queue: sharedQueue,
    now: () => Date.now(),
    storage: browser.storage.local,
  };
}

// ---- Payload parsing -------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function asId(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string' ? asString(String(value)) : null;
}

function invalid(what: string): VintedApiError {
  return new VintedApiError('invalid_response', `Unexpected Vinted payload: ${what}`);
}

function parseMoney(item: JsonObject): Money | null {
  const price = item.price;
  const amount = isRecord(price) ? asNumber(price.amount) : asNumber(price);
  const currency =
    (isRecord(price) ? asString(price.currency_code) : null) ??
    asString(item.currency) ??
    asString(item.currency_code);
  return amount === null || amount < 0 || !currency ? null : { amount, currency };
}

function parseWardrobeItem(raw: unknown): SellerItem | null {
  if (!isRecord(raw)) return null;
  if (raw.is_closed === true || raw.is_hidden === true || raw.is_draft === true) return null;
  const id = asId(raw.id);
  const title = asString(raw.title);
  const price = parseMoney(raw);
  if (!id || !title || !price) return null;

  const photos = Array.isArray(raw.photos) ? raw.photos.filter(isRecord) : [];
  const mainPhoto = photos.find((photo) => photo.is_main === true) ?? photos[0];
  return {
    id,
    title,
    condition: parseCondition({ statusId: asNumber(raw.status_id), label: asString(raw.status) }),
    size: asString(raw.size),
    price,
    photoUrl: mainPhoto ? asString(mainPhoto.url) : null,
  };
}

interface UserInfo {
  id: string;
  login: string;
  feedbackCount: number;
  rating: number | null;
  itemCount: number | null;
}

function parseUser(body: unknown): UserInfo {
  const user = isRecord(body) ? body.user : null;
  if (!isRecord(user)) throw invalid('missing user');
  const id = asId(user.id);
  const login = asString(user.login);
  if (!id || !login) throw invalid('user without id or login');

  const feedbackCount = asNumber(user.feedback_count) ?? 0;
  const reputation = asNumber(user.feedback_reputation);
  return {
    id,
    login,
    feedbackCount,
    // `feedback_reputation` is 0..1; with no feedback at all it carries no information.
    rating:
      reputation !== null && feedbackCount > 0 ? Math.round(reputation * 5 * 100) / 100 : null,
    itemCount: asNumber(user.item_count),
  };
}

function parseWardrobe(body: unknown): { items: SellerItem[]; total: number | null } {
  if (!isRecord(body) || !Array.isArray(body.items)) throw invalid('missing wardrobe items');
  const pagination = isRecord(body.pagination) ? body.pagination : null;
  return {
    items: body.items.map(parseWardrobeItem).filter((item): item is SellerItem => item !== null),
    total: pagination ? asNumber(pagination.total_entries) : null,
  };
}

// ---- HTTP ------------------------------------------------------------------------------------

function errorForStatus(status: number, path: string): VintedApiError {
  const message = `Vinted answered ${status} for ${path}`;
  if (status === 403) return new VintedApiError('blocked', message, status);
  if (status === 429) return new VintedApiError('rate_limited', message, status);
  if (status === 404) return new VintedApiError('not_found', message, status);
  return new VintedApiError('http', message, status);
}

/**
 * Same-origin GET with the page's cookies. The `accept` header is mandatory: without it
 * Cloudflare answers with a challenge page instead of JSON.
 */
function getJson(path: string, deps: ApiDeps): Promise<unknown> {
  return deps.queue.run(async () => {
    let response: Response;
    try {
      response = await deps.fetch(path, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
    } catch (cause) {
      throw new VintedApiError('network', `Request to ${path} failed`, undefined, cause);
    }
    if (!response.ok) throw errorForStatus(response.status, path);
    try {
      return (await response.json()) as unknown;
    } catch (cause) {
      throw new VintedApiError('invalid_response', `${path} did not return JSON`, undefined, cause);
    }
  });
}

// ---- Cache -----------------------------------------------------------------------------------

interface CacheEntry {
  fetchedAt: number;
  seller: Seller;
}

export function sellerCacheKey(sellerId: string): string {
  return `${SELLER_CACHE_KEY_PREFIX}${sellerId}`;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  return (
    isRecord(value) &&
    typeof value.fetchedAt === 'number' &&
    isRecord(value.seller) &&
    Array.isArray(value.seller.items)
  );
}

async function readCache(sellerId: string, deps: ApiDeps): Promise<Seller | null> {
  try {
    const key = sellerCacheKey(sellerId);
    const entry = (await deps.storage.get(key))[key];
    if (!isCacheEntry(entry)) return null;
    const age = deps.now() - entry.fetchedAt;
    return age >= 0 && age < SELLER_CACHE_TTL_MS ? entry.seller : null;
  } catch {
    return null;
  }
}

/** Drops expired entries, then the oldest ones beyond the cap. */
async function pruneCache(deps: ApiDeps): Promise<void> {
  const all = await deps.storage.get(null);
  const entries = Object.entries(all)
    .filter(([key]) => key.startsWith(SELLER_CACHE_KEY_PREFIX))
    .map(([key, value]) => ({ key, fetchedAt: isCacheEntry(value) ? value.fetchedAt : -Infinity }));
  const isFresh = (entry: { fetchedAt: number }) =>
    deps.now() - entry.fetchedAt < SELLER_CACHE_TTL_MS;
  const stale = entries.filter((entry) => !isFresh(entry));
  const surplus = entries
    .filter(isFresh)
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
    .slice(SELLER_CACHE_MAX_ENTRIES);
  const doomed = [...stale, ...surplus].map((entry) => entry.key);
  if (doomed.length > 0) await deps.storage.remove(doomed);
}

async function writeCache(sellerId: string, seller: Seller, deps: ApiDeps): Promise<void> {
  try {
    const entry: CacheEntry = { fetchedAt: deps.now(), seller };
    await deps.storage.set({ [sellerCacheKey(sellerId)]: entry });
    await pruneCache(deps);
  } catch {
    // The cache is an optimisation: a full or unavailable storage must not fail the analysis.
  }
}

// ---- Public API ------------------------------------------------------------------------------

/**
 * The seller's profile and the first page of their wardrobe, cached for 24 hours.
 * Account creation date is not exposed by Vinted, so `createdAt` is always null.
 *
 * @throws {VintedApiError} when either request fails or returns something unexpected.
 */
export async function fetchSeller(
  sellerId: string,
  overrides: Partial<ApiDeps> = {},
): Promise<Seller> {
  if (!/^\d+$/.test(sellerId)) {
    throw new VintedApiError('invalid_request', `Not a Vinted user id: ${sellerId}`);
  }
  const deps = { ...defaultDeps(), ...overrides };

  const cached = await readCache(sellerId, deps);
  if (cached) return cached;

  const user = parseUser(await getJson(`/api/v2/users/${sellerId}`, deps));
  const wardrobe = parseWardrobe(
    await getJson(`/api/v2/wardrobe/${sellerId}/items?page=1&per_page=${WARDROBE_PER_PAGE}`, deps),
  );

  const seller: Seller = {
    id: user.id,
    login: user.login,
    createdAt: null,
    feedbackCount: user.feedbackCount,
    rating: user.rating,
    itemCount: user.itemCount ?? wardrobe.total ?? wardrobe.items.length,
    items: wardrobe.items,
  };
  await writeCache(sellerId, seller, deps);
  return seller;
}
