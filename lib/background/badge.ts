import type { VerdictLevel } from '../model';

/** What the toolbar badge needs of a verdict: nothing but its level and its title. */
export interface BadgeVerdict {
  level: VerdictLevel;
  title: string;
}

/** The part of `browser.action` (Firefox MV2: `browserAction`) the badge uses. */
export interface ToolbarButton {
  setBadgeText(details: { text: string; tabId: number }): unknown;
  setBadgeBackgroundColor(details: { color: string; tabId: number }): unknown;
  setTitle(details: { title: string; tabId: number }): unknown;
}

interface Badge {
  text: string;
  /** The accent of the card for this level (`ui/ListingCard.css`), white text on it stays readable. */
  colour: string;
}

const BADGES: Record<VerdictLevel, Badge> = {
  dropshipping: { text: '!', colour: '#d93025' },
  resold: { text: '?', colour: '#b45309' },
  review: { text: '?', colour: '#b45309' },
  clean: { text: '✓', colour: '#188038' },
};

/** The manifest's `default_title` (`wxt.config.ts`): what the button says when there is no verdict. */
export const DEFAULT_TITLE = 'Fripon';

export const badgeFor = (level: VerdictLevel): Badge => BADGES[level];

export const badgeTitle = (verdict: BadgeVerdict): string => `${DEFAULT_TITLE} — ${verdict.title}`;

/** Never rejects: a tab closed in the meantime, or an API this browser lacks, is no failure. */
async function attempt(call: () => unknown) {
  try {
    await call();
  } catch {
    // Nothing to do for a badge that cannot be drawn.
  }
}

/**
 * Shows `verdict` on the toolbar button for the tab `tabId` only, or clears it for `null` (no
 * badge, the default title). The three calls are independent: one failing leaves the others.
 */
export async function setToolbarBadge(
  button: ToolbarButton | undefined,
  tabId: number,
  verdict: BadgeVerdict | null,
): Promise<void> {
  if (!button) return;
  const badge = verdict ? badgeFor(verdict.level) : null;
  await Promise.all([
    attempt(() => button.setBadgeText({ text: badge?.text ?? '', tabId })),
    // A cleared badge shows nothing, whatever its colour.
    attempt(() => badge && button.setBadgeBackgroundColor({ color: badge.colour, tabId })),
    attempt(() => button.setTitle({ title: verdict ? badgeTitle(verdict) : DEFAULT_TITLE, tabId })),
  ]);
}
