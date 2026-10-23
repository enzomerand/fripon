import { browser } from 'wxt/browser';
import { isRecord } from './json';

/** Small facts about the options page itself, not settings. */
export interface UiState {
  /** The user closed the welcome banner: do not bring it back just because there is no key. */
  welcomeDismissed: boolean;
}

export const UI_STATE_KEY = 'fripon:ui:v1';

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

/** One field, written whole: there is nothing to merge, so no lock either. */
export async function saveUiState(state: UiState): Promise<void> {
  await browser.storage.local.set({ [UI_STATE_KEY]: state });
}
