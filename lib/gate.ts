import { getUsage, type UsageState } from './credits';
import { loadSettings, type Settings } from './settings';

/**
 * Whether the reverse image search may run. This is all a content script ever learns about the
 * keys, and it is only a snapshot taken when the page opened, good for choosing what to show:
 * the background must still `reserve` a credit before each paid call, and never trusts a gate.
 * - no_key: no Vision key saved.
 * - quota: the Vision cap is reached for this period.
 * - manual: key and credits are fine, but the user chose "Au clic".
 * - ready: run it.
 */
export type ImageGate = 'ready' | 'no_key' | 'quota' | 'manual';

export function imageGate(settings: Settings, visionState: UsageState): ImageGate {
  if (settings.keys.vision === '') return 'no_key';
  if (visionState === 'reached') return 'quota';
  if (settings.mode === 'click') return 'manual';
  return 'ready';
}

/** The gate for right now, from the stored settings and Vision counter. */
export async function loadImageGate(now: Date = new Date()): Promise<ImageGate> {
  const settings = await loadSettings();
  const usage = await getUsage('vision', settings.caps.vision, now);
  return imageGate(settings, usage.state);
}
