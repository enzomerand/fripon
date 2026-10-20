import { browser } from 'wxt/browser';
import { OPTIONS_SECTIONS, type OptionsSection } from './messages';

/**
 * Where the options page should scroll to when it is opened or brought to the front. It travels
 * through `storage.session` (kept out of reach of content scripts) rather than the URL, so an
 * options tab that is already open can be reused instead of piling up new ones.
 */
export const PENDING_SECTION_KEY = 'fripon:options:pendingSection';

export type PendingSection = OptionsSection | 'welcome';

const PENDING_SECTIONS: readonly string[] = ['welcome', ...OPTIONS_SECTIONS];

export function isPendingSection(value: unknown): value is PendingSection {
  return typeof value === 'string' && PENDING_SECTIONS.includes(value);
}

/**
 * Background side: opens the options page (or focuses the open one) and asks it to show
 * `section`. Needs no `tabs` permission.
 */
export async function openOptionsAt(section?: PendingSection): Promise<void> {
  try {
    if (section) await browser.storage.session.set({ [PENDING_SECTION_KEY]: section });
    else await browser.storage.session.remove(PENDING_SECTION_KEY);
  } catch {
    // No session storage: the page still opens, just without a target.
  }
  try {
    await browser.runtime.openOptionsPage();
  } catch (error) {
    // Nobody will read it: do not leave it to surprise the next visit.
    await browser.storage.session.remove(PENDING_SECTION_KEY).catch(() => undefined);
    throw error;
  }
}

/** Options page side: the requested section, read once (it is cleared as it is read). */
export async function takePendingSection(): Promise<PendingSection | null> {
  try {
    const stored = (await browser.storage.session.get(PENDING_SECTION_KEY))[PENDING_SECTION_KEY];
    if (stored === undefined) return null;
    await browser.storage.session.remove(PENDING_SECTION_KEY);
    return isPendingSection(stored) ? stored : null;
  } catch {
    return null;
  }
}
