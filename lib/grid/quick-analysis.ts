import { capLocalHeuristics, searchPhoto, type SearchDeps } from '../analysis';
import { imageCheckForSearch } from '../checks/image';
import { checkPhotos } from '../checks/photos';
import { priceCheck } from '../checks/price';
import { isKeyFailure } from '../google/refusal';
import { hexToHash } from '../image/pixels';
import type { AnalyzeImageResponse } from '../messages';
import type { CheckResult, VerdictLevel } from '../model';
import { computeVerdict } from '../verdict';

/** What a result card needs to talk to the background, injected so it can be tested. */
export interface QuickAnalysisDeps extends SearchDeps {
  analyzeImage(url: string): Promise<AnalyzeImageResponse>;
}

/** The verdict a card shows in a results grid: a colour, a title and one line. */
export interface CompactVerdict {
  level: VerdictLevel;
  /** The title of the full verdict, e.g. "Article Shein revendu". */
  title: string;
  /** Where the photo was found, and that this is the reduced analysis. */
  line: string;
}

/** Where the button sends the user when the search cannot run for lack of a key. */
export type KeySection = 'guide' | 'keys';

/**
 * What the reduced analysis of one card ends in. The words follow the states of the card's button:
 * a verdict, no key (or a refused one), the cap reached, or a failure that a new click may fix.
 */
export type QuickOutcome =
  | { status: 'done'; verdict: CompactVerdict }
  /** `guide`: no key saved. `keys`: Google refused the saved one. */
  | { status: 'needsKey'; section: KeySection }
  | { status: 'quota' }
  | { status: 'error'; line: string };

export const QUICK_SUFFIX = 'analyse rapide';
export const NOTHING_FOUND = 'Rien trouvé';
export const SEARCH_IMPOSSIBLE = 'Recherche impossible';

const ERROR: QuickOutcome = { status: 'error', line: SEARCH_IMPOSSIBLE };

/**
 * The compact verdict from the image row (what the search found) and the photos row (the local
 * look at the thumbnail). The rest of the analysis is not run in a grid: no seller, no
 * description, and the price row stays off, like in the full analysis. The rules are the ones of
 * the full verdict (`computeVerdict`), so a card never contradicts the page of its item.
 */
export function compactVerdict(image: CheckResult, photos: CheckResult): CompactVerdict {
  const matches = image.matches ?? [];
  const checks = capLocalHeuristics([image, priceCheck(matches), photos], matches);
  const verdict = computeVerdict({ checks, imageMatches: matches, priceRatio: null });
  // The platform the verdict quotes: the copy of the photo first, else the closest page.
  const platform = (matches.find((match) => match.exact) ?? matches[0])?.platform;
  return {
    level: verdict.level,
    title: verdict.title,
    line: `${platform ?? NOTHING_FOUND} · ${QUICK_SUFFIX}`,
  };
}

/** The photos row for the thumbnail; never rejects: a photo that cannot be read is an off row. */
async function localPhotosRow(photoUrl: string, deps: QuickAnalysisDeps): Promise<CheckResult> {
  try {
    const response = await deps.analyzeImage(photoUrl);
    const main = response?.ok
      ? { hash: hexToHash(response.hash), catalogScore: response.catalogScore }
      : null;
    return checkPhotos({ main, others: [] });
  } catch {
    return checkPhotos({ main: null, others: [] });
  }
}

/**
 * The reduced analysis of one card, started by a click: the reverse image search of its thumbnail
 * (which spends a Vision credit, unless this photo was searched in the last 7 days) and the local
 * look at the same thumbnail, both at once. Nothing is asked of Vinted. Never rejects.
 *
 * `retry` is true when the click follows a failure: the background then tries again a failure it
 * remembers for a moment instead of answering it again.
 */
export async function quickAnalysis(
  photoUrl: string | null,
  deps: QuickAnalysisDeps,
  retry = false,
): Promise<QuickOutcome> {
  if (!photoUrl) return ERROR;
  const [response, photos] = await Promise.all([
    searchPhoto(photoUrl, deps, false, retry),
    localPhotosRow(photoUrl, deps),
  ]);
  switch (response.status) {
    case 'ok':
      return { status: 'done', verdict: compactVerdict(imageCheckForSearch(response), photos) };
    case 'no_key':
      return { status: 'needsKey', section: 'guide' };
    case 'quota':
      return { status: 'quota' };
    case 'error':
      return isKeyFailure(response.reason) ? { status: 'needsKey', section: 'keys' } : ERROR;
    case 'not_cached':
      // Only answers a request for the cache, which a grid never makes.
      return ERROR;
  }
}
