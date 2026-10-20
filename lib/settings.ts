import { browser } from 'wxt/browser';
import { CREDIT_POLICY } from './credits';
import { isRecord } from './json';

/** auto: every check runs on page open. click: paid checks wait for a click (free ones still run). */
export type AnalysisMode = 'auto' | 'click';
/** Paid services reached with the user's own key. */
export type Provider = 'vision' | 'gemini';

export const PROVIDERS: readonly Provider[] = ['vision', 'gemini'];

export interface Settings {
  mode: AnalysisMode;
  /** Google API key per provider, '' = none. Only ever read by the background and the options page. */
  keys: Record<Provider, string>;
  /** Credits allowed per period (see `CREDIT_POLICY`), null = no cap. */
  caps: Record<Provider, number | null>;
}

/** What `saveSettings` accepts: any subset, `keys` and `caps` merged per provider. */
export interface SettingsPatch {
  mode?: AnalysisMode;
  keys?: Partial<Record<Provider, string>>;
  caps?: Partial<Record<Provider, number | null>>;
}

/** `storage.local` key of the whole settings object. */
export const SETTINGS_KEY = 'fripon:settings:v1';

export const DEFAULT_SETTINGS: Settings = {
  mode: 'auto',
  keys: { vision: '', gemini: '' },
  caps: { vision: CREDIT_POLICY.vision.defaultCap, gemini: CREDIT_POLICY.gemini.defaultCap },
};

/** Google API keys are "AIza" followed by 35 URL-safe characters. */
export function isPlausibleGoogleKey(key: string): boolean {
  return /^AIza[0-9A-Za-z_-]{35}$/.test(key);
}

// Field parsers: undefined = missing or invalid. `null` is a real value for a cap (no cap).
const parseMode = (value: unknown): AnalysisMode | undefined =>
  value === 'auto' || value === 'click' ? value : undefined;
const parseKey = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.trim() : undefined;
const parseCap = (value: unknown): number | null | undefined =>
  value === null
    ? null
    : Number.isSafeInteger(value) && (value as number) >= 1
      ? (value as number)
      : undefined;

function orDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

/** Tolerant read: every missing or invalid field falls back to its own default. */
export function parseSettings(raw: unknown): Settings {
  const record = isRecord(raw) ? raw : {};
  const keys = isRecord(record.keys) ? record.keys : {};
  const caps = isRecord(record.caps) ? record.caps : {};
  const d = DEFAULT_SETTINGS;
  return {
    mode: orDefault(parseMode(record.mode), d.mode),
    keys: {
      vision: orDefault(parseKey(keys.vision), d.keys.vision),
      gemini: orDefault(parseKey(keys.gemini), d.keys.gemini),
    },
    caps: {
      vision: orDefault(parseCap(caps.vision), d.caps.vision),
      gemini: orDefault(parseCap(caps.gemini), d.caps.gemini),
    },
  };
}

export async function loadSettings(): Promise<Settings> {
  return parseSettings((await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
}

/**
 * Merges `patch` into the stored settings and returns what was saved. Patch fields that are
 * invalid are ignored (the stored value stays), they never reset a field to its default.
 */
export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = {
    mode: orDefault(parseMode(patch.mode), current.mode),
    keys: { ...current.keys },
    caps: { ...current.caps },
  };
  for (const provider of PROVIDERS) {
    next.keys[provider] = orDefault(parseKey(patch.keys?.[provider]), current.keys[provider]);
    next.caps[provider] = orDefault(parseCap(patch.caps?.[provider]), current.caps[provider]);
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
