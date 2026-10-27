import type { SearchDeps } from '../analysis';
import { sendMessage, type AnalyzeImageResponse, type OptionsSection } from '../messages';

/**
 * What a page (a content script) asks of the background, as the injected dependencies of the
 * analysis. The keys and the credits stay on the other side: this only carries a photo URL there
 * and a verdict back. Shared by the listing card and the grid buttons.
 */

export const searchDeps: SearchDeps = {
  searchImage: (photoUrl, cacheOnly, retry) =>
    sendMessage({
      type: 'searchImage',
      photoUrl,
      ...(cacheOnly && { cacheOnly: true }),
      ...(retry && { retry: true }),
    }),
};

export function analyzeImageViaBackground(url: string): Promise<AnalyzeImageResponse> {
  return sendMessage({ type: 'analyzeImage', url });
}

/** Opens the options page at `section`. Never rejects: a lost message must not hurt the page. */
export function openOptions(section: OptionsSection) {
  void sendMessage({ type: 'openOptions', section }).catch(() => undefined);
}
