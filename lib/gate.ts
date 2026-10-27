import { getUsage, type UsageState } from './credits';
import { loadSettings, type Settings } from './settings';

/**
 * Whether a paid step may run. This is all a content script ever learns about the keys, and it is
 * only a snapshot taken when the page opened, good for choosing what to show: the background
 * must still `reserve` a credit before each paid call, and never trusts a gate.
 * - no_key: no key saved for that service.
 * - quota: the cap is reached for this period.
 * - manual: key and credits are fine, but the user chose "Au clic".
 * - ready: run it.
 */
export type Gate = 'ready' | 'no_key' | 'quota' | 'manual';
/** The reverse image search (Google Vision). */
export type ImageGate = Gate;

/** One gate per paid step: the image search (Vision) and the AI review (Gemini). */
export interface Gates {
  image: ImageGate;
  ai: Gate;
}

function gateFor(key: string, state: UsageState, settings: Settings): Gate {
  if (key === '') return 'no_key';
  if (state === 'reached') return 'quota';
  if (settings.mode === 'click') return 'manual';
  return 'ready';
}

export function imageGate(settings: Settings, visionState: UsageState): ImageGate {
  return gateFor(settings.keys.vision, visionState, settings);
}

/** The gates for right now, from the stored settings and the counters. */
export async function loadGates(now: Date = new Date()): Promise<Gates> {
  const settings = await loadSettings();
  // One read, one catch per gate: a counter that cannot be read means "no key" (nothing is
  // spent) for its own step only, never for the other one.
  const [image, ai] = await Promise.all([
    getUsage('vision', settings.caps.vision, now)
      .then((usage) => imageGate(settings, usage.state))
      .catch((): ImageGate => 'no_key'),
    getUsage('gemini', settings.caps.gemini, now)
      .then((usage) => gateFor(settings.keys.gemini, usage.state, settings))
      .catch((): Gate => 'no_key'),
  ]);
  return { image, ai };
}
