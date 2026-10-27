import type { SearchDeps } from '../analysis';
import type { Gate, Gates } from '../gate';
import type { BadgeVerdict } from './badge';
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

/**
 * Shows the verdict of the open listing on the toolbar button of this tab, or clears it with
 * `null`. Only the level and the title are sent. Never rejects: a lost message (the extension was
 * reloaded under the page) must not hurt the page.
 */
export function setVerdictBadge(verdict: BadgeVerdict | null) {
  const badge = verdict && { level: verdict.level, title: verdict.title };
  void sendMessage({ type: 'setVerdictBadge', verdict: badge }).catch(() => undefined);
}

const GATE_WORDS: readonly Gate[] = ['ready', 'no_key', 'quota', 'manual'];
const NO_GATES: Gates = { image: 'no_key', ai: 'no_key' };

const wordOf = (gate: unknown): Gate =>
  GATE_WORDS.includes(gate as Gate) ? (gate as Gate) : 'no_key';

/**
 * What the background says about the paid steps. The keys never leave it: this is all we learn.
 * Any failure counts as "no key", the safe state in which nothing paid is attempted.
 */
export async function askGates(): Promise<Gates> {
  try {
    const gates = await sendMessage({ type: 'getGates' });
    return { image: wordOf(gates?.image), ai: wordOf(gates?.ai) };
  } catch {
    return NO_GATES;
  }
}

/** Vision credits left in the current period; null without a cap, or when it cannot be known. */
export async function askVisionRemaining(): Promise<number | null> {
  try {
    const usage = await sendMessage({ type: 'getVisionUsage' });
    return typeof usage?.remaining === 'number' ? usage.remaining : null;
  } catch {
    return null;
  }
}
