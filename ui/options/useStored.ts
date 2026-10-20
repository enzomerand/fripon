import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { CREDITS_KEY_PREFIX, getUsage, type Usage } from '../../lib/credits';
import { SETTINGS_KEY, loadSettings, type Provider, type Settings } from '../../lib/settings';

/** Everything the options page shows, read together so the numbers always agree. */
export interface Stored {
  settings: Settings;
  usage: Record<Provider, Usage>;
  /** When it was read: the reference for "demain", "le 1er novembre"... */
  now: Date;
}

/**
 * The stored settings and credit counters, kept up to date: it re-reads whenever either changes
 * (this page, another options tab, or the background spending a credit).
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
      const settings = await loadSettings();
      const [vision, gemini] = await Promise.all([
        getUsage('vision', settings.caps.vision, now),
        getUsage('gemini', settings.caps.gemini, now),
      ]);
      if (mine !== latest.current) return;
      setStored({ settings, usage: { vision, gemini }, now });
      setFailed(false);
    } catch {
      if (mine === latest.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area !== 'local') return;
      if (
        Object.keys(changes).some((k) => k === SETTINGS_KEY || k.startsWith(CREDITS_KEY_PREFIX))
      ) {
        void reload();
      }
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
