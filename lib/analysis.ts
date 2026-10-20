import { checkDescription } from './checks/description';
import { imageCheckOff } from './checks/image';
import { checkPhotos } from './checks/photos';
import { priceCheckOff } from './checks/price';
import { checkSeller } from './checks/seller';
import { hexToHash } from './image/pixels';
import type { AnalyzeImageResponse } from './messages';
import type { CheckId, CheckResult, Listing, Seller, SellerItem, Verdict } from './model';
import { computeVerdict } from './verdict';

/** At most this many of the seller's other items get their main photo analysed. */
export const MAX_OTHER_PHOTOS = 24;
/** Photo analyses running at the same time (each one is a download in the background). */
export const IMAGE_CONCURRENCY = 4;

/** Everything the analysis needs from the outside world, injected so it can be tested. */
export interface AnalysisDeps {
  fetchSeller(sellerId: string): Promise<Seller>;
  analyzeImage(url: string): Promise<AnalyzeImageResponse>;
  now(): Date;
}

export interface AnalysisOptions {
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
}

interface PhotoAnalysis {
  hash: bigint;
  catalogScore: number;
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
 * The image search and the price comparison are not wired yet: they are reported as off, and the
 * verdict says so when it would otherwise be green.
 *
 * @throws {AnalysisCancelledError} when `options.isCancelled` turns true before the end.
 */
export async function analyzeListing(
  listing: Listing,
  deps: AnalysisDeps,
  options: AnalysisOptions = {},
): Promise<AnalysisResult> {
  const cancelled = options.isCancelled ?? (() => false);
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

  const checks: CheckResult[] = [
    imageCheckOff('no_key'),
    priceCheckOff(),
    seller ? guarded('seller', () => checkSeller(seller, deps.now())) : sellerCheckOff(sellerError),
    guarded('photos', () => checkPhotos({ main, others })),
    guarded('description', () => checkDescription(listing)),
  ];

  return { verdict: computeVerdict({ checks, imageMatches: [], priceRatio: null }), checks };
}
