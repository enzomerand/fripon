import { clampReviewInput, type AiReviewInput } from '../ai/input';
import { aiCacheKey, readAiCache, writeAiCache } from '../ai/review-cache';
import { createFailureMemo } from '../google/failure-memo';
import { isAllowedImageUrl } from '../image/analyzer';
import { readVisionCache, visionCacheKey, writeVisionCache } from '../image/search-cache';
import type { AiReviewResponse, SearchImageResponse } from '../messages';
import type { CloudClient, SearchResult } from './client';
import { PHOTO_QUOTA_MEMO_MS, STATUS_AFTER_REFUSAL_MS } from './config';
import type { StatusKeeper } from './status';

export interface CloudStepsDeps {
  client: CloudClient;
  status: StatusKeeper;
  /** The token of the session, null when signed out. Only used to tell sessions apart. */
  token(): Promise<string | null>;
  now?(): number;
}

export interface CloudSteps {
  searchImage(photoUrl: string, cacheOnly?: boolean, retry?: boolean): Promise<SearchImageResponse>;
  aiReview(input: AiReviewInput, cacheOnly?: boolean, retry?: boolean): Promise<AiReviewResponse>;
}

/** The failures that pass by themselves: remembered for a moment, like those of a Google key. */
type Transient = 'network' | 'unavailable';

/** The subscription has nothing left: the card says it is that one, not a personal key's cap. */
const reviewQuota = (): AiReviewResponse => ({ status: 'quota', source: 'cloud' });

/** What a failure of the server is called to the page, and whether it may pass by itself. */
type Described = { word: 'photo'; transient: false } | { word: Transient; transient: true };

/**
 * Never a word of a key problem (`invalid`, `restricted`, `disabled`, `billing`): the user has no
 * key to check, and the card would send them to it. A server that says "slow down" reads as
 * Google not answering: wait, try again.
 */
function describe(
  reason: 'photo' | 'rate_limited' | 'network' | 'unavailable' | 'not_searched',
): Described {
  switch (reason) {
    case 'photo':
      return { word: 'photo', transient: false };
    case 'rate_limited':
    case 'network':
      return { word: 'network', transient: true };
    case 'unavailable':
    case 'not_searched':
      return { word: 'unavailable', transient: true };
  }
}

/**
 * Builds the `searchImage` and `aiReview` handlers of the background for a signed-in account: the
 * same contract as the ones that use the user's own Google keys, with the Fripon server doing the
 * paid work.
 *
 * The steps, cheapest first:
 * 1. What this browser already holds (the 7-day caches of the personal mode, the same ones): a
 *    hit is answered for free, and `cacheOnly` ("Au clic") never goes further than this.
 * 2. A failure the server gave less than 90 seconds ago (`createFailureMemo`, a click's `retry`
 *    skips it): the same failure, without a request.
 * 3. A photo the server refused for want of analyses less than a minute ago: `quota`, without a
 *    request, for that photo only (the search, then the review that follows it, of one listing).
 *    A click's `retry` skips it too.
 * 4. The server decides what the account may do: the cap, the trial, the shared cache. This code
 *    never refuses from the account's status, however dry it looks: the server serves a photo it
 *    already analysed this month for free, even at the cap.
 *
 * The same photo asked twice at once is asked once. Failures are never cached. Neither function
 * rejects.
 */
export function createCloudSteps(deps: CloudStepsDeps): CloudSteps {
  const now = deps.now ?? (() => Date.now());
  const searches = new Map<string, Promise<SearchImageResponse>>();
  const reviews = new Map<string, Promise<AiReviewResponse>>();
  const searchMemo = createFailureMemo<Transient>(now);
  const reviewMemo = createFailureMemo<Transient>(now);
  /** The photos the server refused (402), by cache key, with the account that was refused. */
  const refused = new Map<string, { token: string; until: number }>();

  /**
   * Whether this photo was refused to this account a moment ago, so that asking again would only
   * get the same refusal: it takes a search 402, a review 403 and a second search 402 to learn it
   * otherwise. A click (`retry`) always asks.
   */
  function wasRefused(token: string, photoKey: string, retry: boolean): boolean {
    if (retry) return false;
    const entry = refused.get(photoKey);
    if (!entry) return false;
    if (now() >= entry.until) {
      refused.delete(photoKey);
      return false;
    }
    return entry.token === token;
  }

  function refuse(token: string, photoKey: string) {
    for (const [key, entry] of refused) if (now() >= entry.until) refused.delete(key);
    refused.set(photoKey, { token, until: now() + PHOTO_QUOTA_MEMO_MS });
  }

  // Shared by every account of this browser (and the personal mode): kept, a hit saves a request.
  /** A cache that cannot be read is a cache that is empty. */
  const cachedMatches = (cacheKey: string) => readVisionCache(cacheKey, now()).catch(() => null);
  const cachedReview = (cacheKey: string) => readAiCache(cacheKey, now()).catch(() => null);

  /** The server's own count after a call, and a status that must be read again after a refusal. */
  function afterSearch(result: SearchResult) {
    if (result.ok) {
      if (result.usage) void deps.status.record(result.usage).catch(() => undefined);
    } else if (result.reason === 'quota') {
      // The figures that said "ready" were stale: read them again, but not at every refusal.
      void deps.status.current(STATUS_AFTER_REFUSAL_MS).catch(() => undefined);
    }
  }

  /** One search at the server; a result is kept in the local cache, which was paid for. */
  async function serverSearch(
    token: string,
    photoUrl: string,
    cacheKey: string,
  ): Promise<SearchResult> {
    const result = await deps.client.search(photoUrl);
    afterSearch(result);
    if (result.ok) {
      refused.delete(cacheKey);
      await writeVisionCache(cacheKey, result.matches, now()).catch(() => undefined);
    } else if (result.reason === 'quota') {
      refuse(token, cacheKey);
    }
    return result;
  }

  async function runSearch(
    photoUrl: string,
    cacheKey: string,
    retry: boolean,
  ): Promise<SearchImageResponse> {
    const generation = searchMemo.generation();
    const cached = await cachedMatches(cacheKey);
    if (cached) return { status: 'ok', matches: cached };

    const token = await deps.token();
    if (token === null) return { status: 'no_key' };
    const remembered = searchMemo.recall(token, retry);
    if (remembered) return { status: 'error', reason: remembered };
    if (wasRefused(token, cacheKey, retry)) return { status: 'quota' };

    const result = await serverSearch(token, photoUrl, cacheKey);
    if (result.ok) {
      searchMemo.forget();
      return { status: 'ok', matches: result.matches };
    }
    // The server refused the session (a 401): the card asks the user to sign in again.
    if (result.reason === 'signed_out') return { status: 'expired' };
    if (result.reason === 'quota') return { status: 'quota' };
    const failure = describe(result.reason);
    if (failure.transient) searchMemo.remember(token, failure.word, generation);
    return { status: 'error', reason: failure.word };
  }

  async function runReview(
    input: AiReviewInput,
    cacheKey: string,
    retry: boolean,
  ): Promise<AiReviewResponse> {
    const generation = reviewMemo.generation();
    const cached = await cachedReview(cacheKey);
    if (cached) return { status: 'ok', review: cached };

    const token = await deps.token();
    if (token === null) return { status: 'no_key' };
    const remembered = reviewMemo.recall(token, retry);
    if (remembered) return { status: 'error', reason: remembered };

    // The review follows the search of the same photo: if the server just refused that one, this
    // listing is out of analyses, and the review would only be refused (403, then 402 on the
    // search it would have the server make).
    const searchKey = visionCacheKey(input.photoUrl);
    if (wasRefused(token, searchKey, retry)) return reviewQuota();

    let result = await deps.client.review(input);
    if (!result.ok && result.reason === 'not_searched') {
      // The server only reviews a photo it served to this account lately. A photo searched before
      // signing in, or in another account, only has its search in this browser's cache: have the
      // server serve it (one analysis, which this account would have paid the first time), then
      // ask again, once. The server may serve it for free (analysed this month) even at the cap.
      const served = await serverSearch(token, input.photoUrl, searchKey);
      if (!served.ok) {
        if (served.reason === 'signed_out') return { status: 'expired' };
        if (served.reason === 'quota') return reviewQuota();
        return { status: 'error', reason: describe(served.reason).word };
      }
      result = await deps.client.review(input);
    }

    if (result.ok) {
      reviewMemo.forget();
      // The review was served: a cache that cannot be written must not hide it.
      await writeAiCache(cacheKey, result.review, now()).catch(() => undefined);
      return { status: 'ok', review: result.review };
    }
    if (result.reason === 'signed_out') return { status: 'expired' };
    if (result.reason === 'invalid_answer') return { status: 'error', reason: 'invalid_answer' };
    const failure = describe(result.reason);
    if (failure.transient) reviewMemo.remember(token, failure.word, generation);
    return { status: 'error', reason: failure.word };
  }

  return {
    searchImage(photoUrl, cacheOnly = false, retry = false) {
      // Validated first: a refused URL never reaches the cache or the network.
      if (!isAllowedImageUrl(photoUrl)) {
        return Promise.resolve({ status: 'error', reason: 'photo' });
      }
      const cacheKey = visionCacheKey(photoUrl);
      if (cacheOnly) {
        return cachedMatches(cacheKey).then((cached): SearchImageResponse =>
          cached ? { status: 'ok', matches: cached } : { status: 'not_cached' },
        );
      }
      const pending = searches.get(cacheKey);
      if (pending) return pending;
      const search = runSearch(photoUrl, cacheKey, retry)
        .catch((): SearchImageResponse => ({ status: 'error', reason: 'network' }))
        .finally(() => searches.delete(cacheKey));
      searches.set(cacheKey, search);
      return search;
    },

    aiReview(rawInput, cacheOnly = false, retry = false) {
      if (!isAllowedImageUrl(rawInput.photoUrl)) {
        return Promise.resolve({ status: 'error', reason: 'photo' });
      }
      const input = clampReviewInput(rawInput);
      const cacheKey = aiCacheKey(input.photoUrl, input);
      if (cacheOnly) {
        return cachedReview(cacheKey).then((cached): AiReviewResponse =>
          cached ? { status: 'ok', review: cached } : { status: 'not_cached' },
        );
      }
      const pending = reviews.get(cacheKey);
      if (pending) return pending;
      const review = runReview(input, cacheKey, retry)
        .catch((): AiReviewResponse => ({ status: 'error', reason: 'network' }))
        .finally(() => reviews.delete(cacheKey));
      reviews.set(cacheKey, review);
      return review;
    },
  };
}
