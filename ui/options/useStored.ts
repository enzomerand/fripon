import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { SESSION_KEY, STATUS_KEY, loadExpired, loadStatus } from '../../lib/cloud/session';
import type { CloudStatus } from '../../lib/cloud/types';
import { CREDITS_KEY_PREFIX, getUsage, type Usage } from '../../lib/credits';
import { SETTINGS_KEY, loadSettings, type Provider, type Settings } from '../../lib/settings';
import { UI_STATE_KEY, loadUiState, type UiState } from '../../lib/ui-state';

/** Everything the options page shows, read together so the numbers always agree. */
export interface Stored {
  settings: Settings;
  usage: Record<Provider, Usage>;
  ui: UiState;
  /** The Fripon Cloud account without its token, null when signed out. */
  cloud: CloudStatus | null;
  /** The address of a subscription whose session expired (to sign in again), null otherwise. */
  cloudExpired: { email: string } | null;
  /** When it was read: the reference for "à 9 h", "le 1er novembre"... */
  now: Date;
}

/**
 * The stored settings, credit counters and subscription status, kept up to date: it re-reads
 * whenever one changes (this page, another options tab, or the background spending a credit or
 * reading the account). The page only reads the counters and the status; the background is the
 * one that writes them.
 */
export function useStored() {
  const [stored, setStored] = useState<Stored | null>(null);
  const [failed, setFailed] = useState(false);
  // Only the latest read may land: an older, slower one would show stale numbers.
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const now = new Date();
      const [settings, ui, cloud, cloudExpired] = await Promise.all([
        loadSettings(),
        loadUiState(),
        loadStatus(),
        loadExpired(),
      ]);
      const [vision, gemini] = await Promise.all([
        getUsage('vision', settings.caps.vision, now),
        getUsage('gemini', settings.caps.gemini, now),
      ]);
      if (mine !== latest.current) return;
      setStored({ settings, usage: { vision, gemini }, ui, cloud, cloudExpired, now });
      setFailed(false);
    } catch {
      if (mine === latest.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area !== 'local') return;
      const relevant = Object.keys(changes).some(
        (k) =>
          k === SETTINGS_KEY ||
          k === UI_STATE_KEY ||
          k === STATUS_KEY ||
          k === SESSION_KEY ||
          k.startsWith(CREDITS_KEY_PREFIX),
      );
      if (relevant) void reload();
    };
    // A page left open overnight must not keep yesterday's counters.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    browser.storage.onChanged.addListener(onChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      browser.storage.onChanged.removeListener(onChanged);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  return { stored, failed, reload };
}
