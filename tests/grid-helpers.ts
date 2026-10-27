import type { QuickAnalysisDeps } from '../lib/grid/quick-analysis';
import type { AnalyzeImageResponse } from '../lib/messages';

/** The background's answer for a photo it could read: a plain, non-catalog picture. */
export const ANALYZED_PHOTO: AnalyzeImageResponse = {
  ok: true,
  hash: '0f0f0f0f0f0f0f0f',
  catalogScore: 0.1,
};

/** The `analyzeImage` dependency of a grid test: every photo reads fine. */
export const analyzeImage: QuickAnalysisDeps['analyzeImage'] = () =>
  Promise.resolve(ANALYZED_PHOTO);

/** Polls until `predicate` holds; `diagnostic` adds what the test can see to the timeout error. */
export async function until(
  predicate: () => boolean,
  timeoutMs = 2_000,
  diagnostic?: () => string,
) {
  const begin = Date.now();
  while (!predicate()) {
    if (Date.now() - begin > timeoutMs) {
      throw new Error(diagnostic ? `Timed out: ${diagnostic()}` : 'Timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets pending promises and short timers run, for « nothing happens » assertions. */
export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
