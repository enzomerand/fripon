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
/** Prefix of the `storage.local` keys holding cached sellers (`<prefix><hostname>:<id>`). */
export const SELLER_CACHE_KEY_PREFIX = 'fripon:seller:v1:';
/** A request (headers and body) that takes longer than this is abandoned, so the queue never hangs. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Pause after Vinted answers 403 / 429 without a usable `Retry-After`. */
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1_000;
/** A `Retry-After` longer than this is capped, so one odd header cannot silence the extension. */
export const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
/** `storage.local` key (per hostname) of the last reserved request slot, shared by all tabs. */
export const LAST_REQUEST_KEY_PREFIX = 'fripon:lastRequestAt:';
/** `storage.local` key (per hostname) of the end of the current cooldown. */
export const COOLDOWN_KEY_PREFIX = 'fripon:cooldownUntil:';

export type VintedApiErrorCode =
  /** The id is not a numeric Vinted user id; nothing was sent. */
  | 'invalid_request'
  /** 403: Cloudflare / DataDome challenge. */
  | 'blocked'
  /** 429, or a cooldown after a 403 / 429: nothing was sent while it lasts. */
  | 'rate_limited'
  | 'not_found'
  /** Any other non-2xx status. */
  | 'http'
  /** The request itself failed (offline, extension context gone...). */
  | 'network'
  /** No answer within `REQUEST_TIMEOUT_MS`. */
  | 'timeout'
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

/** Where the time of the last reserved request slot is kept, to share it between pages. */
export interface SpacingStore {
  load(): Promise<number | null>;
  save(at: number): Promise<void>;
}

interface StorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Keeps the last slot in `storage.local` under `key()`. Failures are ignored: best effort. */
export function storageSpacingStore(storage: StorageLike, key: () => string): SpacingStore {
  return {
    async load() {
      try {
        const value = (await storage.get(key()))[key()];
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
      } catch {
        return null;
      }
    },
    async save(at) {
      try {
        await storage.set({ [key()]: at });
      } catch {
        // Spacing then only holds within this page.
      }
    },
  };
}

/**
 * Runs tasks one at a time, starting each at least `spacingMs` after the previous one started.
 * With a `store`, the slot is also reserved in shared storage, so other pages and tabs of the same
 * site keep their distance too (best effort: there is no lock between tabs).
 */
export class RequestQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly spacingMs: number,
    private readonly clock: Clock = realClock,
    private readonly store?: SpacingStore,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const shared = (await this.store?.load()) ?? Number.NEGATIVE_INFINITY;
      const slot = Math.max(this.clock.now(), Math.max(this.lastStart, shared) + this.spacingMs);
      this.lastStart = slot;
      // Reserve the slot before waiting for it, so another tab reading now queues behind us.
      await this.store?.save(slot);
      const wait = slot - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      return task();
    });
    // A failed task must not block the ones behind it.
    this.tail = result.catch(() => undefined);
    return result;
  }
}

function currentHostname(): string {
  return globalThis.location?.hostname ?? '';
}

/** The one queue shared by every Vinted API call of this page (and, via storage, of its tabs). */
const sharedQueue = new RequestQueue(
  MIN_REQUEST_SPACING_MS,
  realClock,
  storageSpacingStore(
    {
      get: (key) => browser.storage.local.get(key),
      set: (items) => browser.storage.local.set(items),
    },
    () => `${LAST_REQUEST_KEY_PREFIX}${currentHostname()}`,
  ),
);

// ---- Dependencies ----------------------------------------------------------------------------

export interface ApiDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  queue: RequestQueue;
  now: () => number;
  storage: Pick<Browser.storage.StorageArea, 'get' | 'set' | 'remove'>;
}

/** Everything `fetchSeller` can be given; each field defaults to the real thing. */
export interface ApiOverrides extends Partial<ApiDeps> {
  /** Site the requests go to (the cache and cooldown are per site). */
  hostname?: string;
  timeoutMs?: number;
}

type ResolvedDeps = ApiDeps & { hostname: string; timeoutMs: number };

function resolveDeps(overrides: ApiOverrides): ResolvedDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    queue: sharedQueue,
    now: () => Date.now(),
    storage: browser.storage.local,
    hostname: currentHostname(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...overrides,
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

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'TimeoutError'
  );
}

// ---- Cooldown --------------------------------------------------------------------------------

function cooldownKey(deps: ResolvedDeps): string {
  return `${COOLDOWN_KEY_PREFIX}${deps.hostname}`;
}

/** Milliseconds to wait according to a `Retry-After` header (seconds or HTTP date), if usable. */
function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_COOLDOWN_MS) : null;
}

/** Remembers, for every tab of this site, that Vinted asked us to back off. */
async function startCooldown(response: Response, deps: ResolvedDeps): Promise<void> {
  const wait = retryAfterMs(response.headers.get('retry-after'), deps.now()) ?? DEFAULT_COOLDOWN_MS;
  try {
    await deps.storage.set({ [cooldownKey(deps)]: deps.now() + wait });
  } catch {
    // Without storage the cooldown only lasts as long as this error.
  }
}

/** @throws {VintedApiError} `rate_limited`, without any request, while a cooldown is running. */
async function assertNoCooldown(deps: ResolvedDeps): Promise<void> {
  let until: unknown;
  try {
    until = (await deps.storage.get(cooldownKey(deps)))[cooldownKey(deps)];
  } catch {
    return;
  }
  if (typeof until === 'number' && until > deps.now()) {
    throw new VintedApiError(
      'rate_limited',
      `Vinted asked us to back off, no request until ${new Date(until).toISOString()}`,
    );
  }
}

/**
 * Same-origin GET with the page's cookies. The `accept` header is mandatory: without it
 * Cloudflare answers with a challenge page instead of JSON.
 */
function getJson(path: string, deps: ResolvedDeps): Promise<unknown> {
  return deps.queue.run(async () => {
    // Checked inside the queue too: another tab may have been refused while this one waited.
    await assertNoCooldown(deps);
    let response: Response;
    try {
      response = await deps.fetch(path, {
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
    } catch (cause) {
      throw new VintedApiError(
        isTimeout(cause) ? 'timeout' : 'network',
        `Request to ${path} failed`,
        undefined,
        cause,
      );
    }
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) await startCooldown(response, deps);
      throw errorForStatus(response.status, path);
    }
    try {
      return (await response.json()) as unknown;
    } catch (cause) {
      throw new VintedApiError(
        isTimeout(cause) ? 'timeout' : 'invalid_response',
        `${path} did not return JSON in time`,
        undefined,
        cause,
      );
    }
  });
}

// ---- Cache -----------------------------------------------------------------------------------

interface CacheEntry {
  fetchedAt: number;
  seller: Seller;
}

export function sellerCacheKey(sellerId: string, hostname = currentHostname()): string {
  return `${SELLER_CACHE_KEY_PREFIX}${hostname}:${sellerId}`;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  return (
    isRecord(value) &&
    typeof value.fetchedAt === 'number' &&
    isRecord(value.seller) &&
    Array.isArray(value.seller.items)
  );
}

async function readCache(sellerId: string, deps: ResolvedDeps): Promise<Seller | null> {
  try {
    const key = sellerCacheKey(sellerId, deps.hostname);
    const entry = (await deps.storage.get(key))[key];
    if (!isCacheEntry(entry)) return null;
    const age = deps.now() - entry.fetchedAt;
    return age >= 0 && age < SELLER_CACHE_TTL_MS ? entry.seller : null;
  } catch {
    return null;
  }
}

/** Drops expired entries, then the oldest ones beyond the cap. */
async function pruneCache(deps: ResolvedDeps): Promise<void> {
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

async function writeCache(sellerId: string, seller: Seller, deps: ResolvedDeps): Promise<void> {
  try {
    const entry: CacheEntry = { fetchedAt: deps.now(), seller };
    await deps.storage.set({ [sellerCacheKey(sellerId, deps.hostname)]: entry });
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
 * While Vinted has asked us to back off (403 / 429), nothing is sent and `rate_limited` is thrown.
 *
 * @throws {VintedApiError} when either request fails or returns something unexpected.
 */
export async function fetchSeller(sellerId: string, overrides: ApiOverrides = {}): Promise<Seller> {
  if (!/^\d+$/.test(sellerId)) {
    throw new VintedApiError('invalid_request', `Not a Vinted user id: ${sellerId}`);
  }
  const deps = resolveDeps(overrides);

  const cached = await readCache(sellerId, deps);
  if (cached) return cached;
  await assertNoCooldown(deps);

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
