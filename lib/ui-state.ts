import { browser } from 'wxt/browser';
import { isRecord } from './json';
import { withLock } from './lock';

/** Small facts about the options page itself, not settings. */
export interface UiState {
  /** The user closed the welcome banner: do not bring it back just because there is no key. */
  welcomeDismissed: boolean;
}

export const UI_STATE_KEY = 'fripon:ui:v1';
const UI_STATE_LOCK = 'fripon:ui';

export const DEFAULT_UI_STATE: UiState = { welcomeDismissed: false };

/** Tolerant read: an invalid field falls back to its default. */
export function parseUiState(raw: unknown): UiState {
  const record = isRecord(raw) ? raw : {};
  return {
    welcomeDismissed:
      typeof record.welcomeDismissed === 'boolean'
        ? record.welcomeDismissed
        : DEFAULT_UI_STATE.welcomeDismissed,
  };
}

export async function loadUiState(): Promise<UiState> {
  return parseUiState((await browser.storage.local.get(UI_STATE_KEY))[UI_STATE_KEY]);
}

export function saveUiState(patch: Partial<UiState>): Promise<UiState> {
  return withLock(UI_STATE_LOCK, async () => {
    const next = parseUiState({ ...(await loadUiState()), ...patch });
    await browser.storage.local.set({ [UI_STATE_KEY]: next });
    return next;
  });
}
