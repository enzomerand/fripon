import { clampReviewInput, type AiReviewInput } from '../ai/input';
import { aiCacheKey, readAiCache, writeAiCache } from '../ai/review-cache';
import { createFailureMemo } from '../google/failure-memo';
import { isAllowedImageUrl } from '../image/analyzer';
import { readVisionCache, visionCacheKey, writeVisionCache } from '../image/search-cache';
import type { AiReviewResponse, SearchImageResponse } from '../messages';
import type { CloudClient, SearchResult } from './client';
import { STATUS_AFTER_REFUSAL_MS, STATUS_MAX_AGE_MS } from './config';
import { canAnalyse, type StatusKeeper } from './status';

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

/**
 * After the server refused for want of analyses, and while a status read is that young, the account
 * is not asked again: the same minute as `STATUS_MAX_AGE_MS`, which is how stale a status may be.
 */
const DRY_MEMO_MS = STATUS_MAX_AGE_MS;

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
 * 3. An account known to be dry, for a minute (the server refused it, or the last status says so):
 *    `quota`, without a request. A click's `retry` skips it too.
 * 4. The server decides what the account may do: the cap, the trial, the shared cache. Short of
 *    a refusal it gave or a status that says there is nothing left, this code does not
 *    second-guess it: the stored status may be a minute old.
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
  /** The account the server last refused for want of analyses, in memory only. */
  let dry: { token: string; until: number } | null = null;

  /**
   * Whether asking the server would only get a refusal: it said "no analysis left" less than a
   * minute ago, or the last status read (never older than a minute) says the month, a day or the
   * trial is used up. Without this, every listing of a dry account costs a search refused, a review
   * refused and a second search refused. A click (`retry`) always asks.
   */
  async function isDry(token: string, retry: boolean): Promise<boolean> {
    if (retry) return false;
    if (dry?.token === token && now() < dry.until) return true;
    const stored = await deps.status.peek(STATUS_MAX_AGE_MS).catch(() => null);
    return stored?.usage ? !canAnalyse(stored.usage) : false;
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
      dry = null;
      await writeVisionCache(cacheKey, result.matches, now()).catch(() => undefined);
    } else if (result.reason === 'quota') {
      dry = { token, until: now() + DRY_MEMO_MS };
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
    if (await isDry(token, retry)) return { status: 'quota' };

    const result = await serverSearch(token, photoUrl, cacheKey);
    if (result.ok) {
      searchMemo.forget();
      return { status: 'ok', matches: result.matches };
    }
    if (result.reason === 'signed_out') return { status: 'no_key' };
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

    // A dry account can still have a photo reviewed that the server served it a moment ago (the
    // search that took its last analysis): the review is free then. Only a photo this browser
    // never searched is answered here, as the server would refuse it, or serve it for an analysis
    // the account no longer has.
    const searchKey = visionCacheKey(input.photoUrl);
    if ((await isDry(token, retry)) && !(await cachedMatches(searchKey))) return reviewQuota();

    let result = await deps.client.review(input);
    if (!result.ok && result.reason === 'not_searched') {
      // The server only reviews a photo it served to this account lately. A photo searched before
      // signing in, or in another account, only has its search in this browser's cache: have the
      // server serve it (one analysis, which this account would have paid the first time), then
      // ask again, once.
      if (await isDry(token, retry)) return reviewQuota();
      const served = await serverSearch(token, input.photoUrl, searchKey);
      if (!served.ok) {
        if (served.reason === 'signed_out') return { status: 'no_key' };
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
    if (result.reason === 'signed_out') return { status: 'no_key' };
    if (result.reason === 'quota') {
      dry = { token, until: now() + DRY_MEMO_MS };
      return reviewQuota();
    }
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
