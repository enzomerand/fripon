import { buildReviewInput, type AiReviewInput } from './ai/input';
import { checkDescription } from './checks/description';
import { imageCheckForSearch, imageCheckOff, imageCheckSearching } from './checks/image';
import { checkPhotos, confirmCatalogPhoto } from './checks/photos';
import { priceCheckOff } from './checks/price';
import { checkSeller } from './checks/seller';
import type { ImageGate } from './gate';
import { hexToHash } from './image/pixels';
import type { AiReviewResponse, AnalyzeImageResponse, SearchImageResponse } from './messages';
import type {
  AiReview,
  CheckId,
  CheckResult,
  ImageMatch,
  Listing,
  Seller,
  SellerItem,
  Verdict,
} from './model';
import { computeVerdict } from './verdict';

/** At most this many of the seller's other items get their main photo analysed. */
export const MAX_OTHER_PHOTOS = 24;
/** Photo analyses running at the same time (each one is a download in the background). */
export const IMAGE_CONCURRENCY = 4;

/** Everything the analysis needs from the outside world, injected so it can be tested. */
export interface AnalysisDeps {
  fetchSeller(sellerId: string): Promise<Seller>;
  analyzeImage(url: string): Promise<AnalyzeImageResponse>;
}

/**
 * The reverse image search, apart from `AnalysisDeps` on purpose: it is not part of the analysis.
 * The card is shown from the free checks first, then the search runs on its own (see
 * `searchPhoto` and `withImageSearch`), automatically or on a click.
 */
export interface SearchDeps {
  /** With `cacheOnly` the background never spends: the cached result, or `not_cached`. */
  searchImage(photoUrl: string, cacheOnly?: boolean): Promise<SearchImageResponse>;
}

/**
 * The AI review, apart from `AnalysisDeps` and `SearchDeps` for the same reason: it is a paid call
 * that runs on its own, after the image search, with every signal the card already has.
 */
export interface AiDeps {
  /** With `cacheOnly` the background never spends: the cached review, or `not_cached`. */
  aiReview(input: AiReviewInput, cacheOnly?: boolean): Promise<AiReviewResponse>;
}

export interface AnalysisOptions {
  /** What the background says about the image search; 'no_key' when not given. */
  imageGate?: ImageGate;
  /** Polled between steps: once true, no further request is made and the analysis is abandoned. */
  isCancelled?: () => boolean;
}

/** Thrown by `analyzeListing` when `isCancelled` turned true; callers just drop the run. */
export class AnalysisCancelledError extends Error {
  constructor() {
    super('Analysis cancelled');
    this.name = 'AnalysisCancelledError';
  }
}

export interface AnalysisResult {
  verdict: Verdict;
  /** In display order: image, price, seller, photos, description. */
  checks: CheckResult[];
  /**
   * The same rows before `capLocalHeuristics` and before the AI review: whether a local row may be
   * red depends on the image matches, and the AI confirmation is applied on top, so a later image
   * search or review must start from these, not from `checks`.
   */
  rawChecks: CheckResult[];
  /** What the AI said, null until a review came back. Only `catalogPhoto` can change the rows. */
  aiReview: AiReview | null;
}

interface PhotoAnalysis {
  hash: bigint;
  catalogScore: number;
}

/** Checks that only rely on local heuristics (no image search result behind them). */
const LOCAL_HEURISTIC_CHECKS: ReadonlySet<CheckId> = new Set(['seller', 'photos', 'description']);

/**
 * Without an exact image match, nothing proves the listing is a copy: a local heuristic row may
 * be orange at worst, never red. The signals themselves are untouched, so the verdict still sees
 * them. This is the one place where that rule lives.
 */
export function capLocalHeuristics(
  checks: CheckResult[],
  imageMatches: ImageMatch[],
): CheckResult[] {
  if (imageMatches.some((match) => match.exact)) return checks;
  return checks.map((check) =>
    LOCAL_HEURISTIC_CHECKS.has(check.id) && check.status === 'bad'
      ? { ...check, status: 'warn' }
      : check,
  );
}

/**
 * Searches the listing's main photo (a paid call, unless `cacheOnly`). Never rejects: a photo that
 * is missing, a background that does not answer or a context that was invalidated all count as a
 * failed search.
 */
export async function searchPhoto(
  photoUrl: string | undefined,
  deps: SearchDeps,
  cacheOnly = false,
): Promise<SearchImageResponse> {
  if (!photoUrl) return { status: 'error', reason: 'photo' };
  try {
    const response = await deps.searchImage(photoUrl, cacheOnly);
    // A background that did not answer at all resolves with `undefined`.
    return typeof response?.status === 'string' ? response : { status: 'error', reason: 'network' };
  } catch {
    return { status: 'error', reason: 'network' };
  }
}

/**
 * Asks the AI to review the listing from the signals of `result` (a paid call, unless
 * `cacheOnly`). Never rejects: a listing without a photo, a background that does not answer or a
 * context that was invalidated all count as a failed review.
 */
export async function askAiReview(
  listing: Listing,
  result: AnalysisResult,
  deps: AiDeps,
  cacheOnly = false,
): Promise<AiReviewResponse> {
  if (!listing.photoUrls[0]) return { status: 'error', reason: 'photo' };
  try {
    const response = await deps.aiReview(buildReviewInput(listing, result.rawChecks), cacheOnly);
    // A background that did not answer at all resolves with `undefined`.
    return typeof response?.status === 'string' ? response : { status: 'error', reason: 'network' };
  } catch {
    return { status: 'error', reason: 'network' };
  }
}

/**
 * Applies the AI review to the rows, caps the local rows by what the image row found, then decides
 * the verdict. This is the one path `analyzeListing`, `withImageSearch` and `withAiReview` all end
 * in, so the steps compose in any order: each one swaps its own input and the rest is redone from
 * the stored raw rows. The price comparison belongs here too: the price row and `priceRatio`
 * depend on the image matches, and building them anywhere else would leave the "Au clic" path
 * with the old row and a null ratio.
 *
 * The AI only ever confirms a signal: a `catalogPhoto: true` makes the catalogue signal of the
 * photos row strong, and the verdict rules do the rest. It never decides the verdict itself.
 */
function assemble(rawChecks: CheckResult[], aiReview: AiReview | null): AnalysisResult {
  const imageMatches = rawChecks.find((check) => check.id === 'image')?.matches ?? [];
  const reviewed = aiReview?.catalogPhoto
    ? rawChecks.map((check) => (check.id === 'photos' ? confirmCatalogPhoto(check) : check))
    : rawChecks;
  const checks = capLocalHeuristics(reviewed, imageMatches);
  return {
    verdict: computeVerdict({ checks, imageMatches, priceRatio: null }),
    checks,
    rawChecks,
    aiReview,
  };
}

/**
 * The analysis again, with the image row replaced by what a search found. Nothing else is
 * recomputed: no seller request, no photo download. Used by the "Au clic" button.
 */
export function withImageSearch(
  result: AnalysisResult,
  response: SearchImageResponse,
): AnalysisResult {
  const image = imageCheckForSearch(response);
  return assemble(
    result.rawChecks.map((check) => (check.id === 'image' ? image : check)),
    result.aiReview,
  );
}

/**
 * The analysis again, with what the AI reviewed. Only an answer that holds a review changes
 * anything: no key, no credits or a failure leave the result as it is (the card says why in its
 * AI block). Nothing is recomputed but the rows and the verdict.
 */
export function withAiReview(result: AnalysisResult, response: AiReviewResponse): AnalysisResult {
  return response.status === 'ok' ? assemble(result.rawChecks, response.review) : result;
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping the order of the results. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** null when the photo could not be fetched or decoded: the check then skips it. */
async function analyzePhoto(url: string, deps: AnalysisDeps): Promise<PhotoAnalysis | null> {
  try {
    const response = await deps.analyzeImage(url);
    if (!response.ok) return null;
    return { hash: hexToHash(response.hash), catalogScore: response.catalogScore };
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function sellerCheckOff(error: unknown): CheckResult {
  const limited = ['blocked', 'rate_limited'].includes(errorCode(error) ?? '');
  return {
    id: 'seller',
    status: 'off',
    tag: 'Indisponible',
    detail: limited
      ? "Vinted limite les requêtes pour l'instant, réessaie dans quelques minutes."
      : "Impossible de charger les infos du vendeur pour l'instant.",
    signals: [],
  };
}

/** A synchronous check must never take the whole analysis down. */
function guarded(id: CheckId, run: () => CheckResult): CheckResult {
  try {
    return run();
  } catch {
    return {
      id,
      status: 'off',
      tag: 'Indisponible',
      detail: "Cette vérification a rencontré un problème, elle n'a pas pu être faite.",
      signals: [],
    };
  }
}

/**
 * Runs every check on a listing and combines them into a verdict. A step that cannot run (seller
 * request refused, photo unreachable) turns its own check `off` and leaves the others intact.
 *
 * The image search is not part of it: it is a paid call that must not hold the card back. The
 * image row says "Recherche en cours…" when the gate is "ready" (the caller then runs the search),
 * and why it does not run in the other gates. The price comparison is not wired yet: it is
 * reported as off, and the verdict says so when it would otherwise be green.
 *
 * @throws {AnalysisCancelledError} when `options.isCancelled` turns true before the end.
 */
export async function analyzeListing(
  listing: Listing,
  deps: AnalysisDeps,
  options: AnalysisOptions = {},
): Promise<AnalysisResult> {
  const cancelled = options.isCancelled ?? (() => false);
  const imageGate = options.imageGate ?? 'no_key';
  const ensureActive = () => {
    if (cancelled()) throw new AnalysisCancelledError();
  };

  ensureActive();
  let seller: Seller | null = null;
  let sellerError: unknown;
  try {
    seller = await deps.fetchSeller(listing.sellerId);
  } catch (error) {
    sellerError = error;
  }
  ensureActive();

  const mainUrl = listing.photoUrls[0];
  const otherItems: SellerItem[] = (seller?.items ?? [])
    .filter((item) => item.id !== listing.id && item.photoUrl !== null)
    .slice(0, MAX_OTHER_PHOTOS);

  const urls = [
    ...(mainUrl ? [mainUrl] : []),
    ...otherItems.map((item) => item.photoUrl as string),
  ];
  // Once cancelled, the photos still queued are skipped instead of being downloaded.
  const analyses = await mapWithConcurrency(urls, IMAGE_CONCURRENCY, (url) =>
    cancelled() ? Promise.resolve(null) : analyzePhoto(url, deps),
  );
  ensureActive();
  const offset = mainUrl ? 1 : 0;
  const main = mainUrl ? (analyses[0] ?? null) : null;
  const others = otherItems.flatMap((item, index) => {
    const analysis = analyses[index + offset];
    return analysis ? [{ itemId: item.id, hash: analysis.hash }] : [];
  });

  return assemble(
    [
      imageGate === 'ready' ? imageCheckSearching() : imageCheckOff(imageGate),
      priceCheckOff(),
      seller ? guarded('seller', () => checkSeller(seller, others)) : sellerCheckOff(sellerError),
      guarded('photos', () => checkPhotos({ main, others })),
      guarded('description', () => checkDescription(listing)),
    ],
    null,
  );
}
