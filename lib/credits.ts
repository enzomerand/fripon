import { browser } from 'wxt/browser';
import { isRecord } from './json';
import type { Provider } from './settings';

/**
 * What a paid provider gives for free, and so where Fripon stops by default. "Credit" = one paid
 * call. The counters are local: they cannot see what the same key spends elsewhere.
 */
export const CREDIT_POLICY: Record<Provider, { period: 'month' | 'day'; defaultCap: number }> = {
  // Web Detection free tier: 1,000 units per month.
  vision: { period: 'month', defaultCap: 1_000 },
  // Lowest published free-tier requests-per-day among the current Flash models.
  // To revisit in lot 4, when the real Gemini calls (and their model) are chosen.
  gemini: { period: 'day', defaultCap: 20 },
};

/** The user is warned once this share of the cap is spent. */
export const WARN_RATIO = 0.8;

/** Prefix of the `storage.local` counters: `<prefix><provider>:<periodId>`. */
export const CREDITS_KEY_PREFIX = 'fripon:credits:v1:';

export type UsageState = 'ok' | 'warning' | 'reached';

export interface Usage {
  used: number;
  /** null = no cap. */
  cap: number | null;
  state: UsageState;
  /** Local midnight at which the counter starts again from zero. */
  resetsAt: Date;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `YYYY-MM` (monthly provider) or `YYYY-MM-DD` (daily provider), in the user's local time. */
export function periodId(provider: Provider, now: Date): string {
  const month = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}`;
  return CREDIT_POLICY[provider].period === 'month' ? month : `${month}-${pad(now.getDate())}`;
}

/** The first local midnight after `now` that starts a new period for this provider. */
export function nextReset(provider: Provider, now: Date): Date {
  return CREDIT_POLICY[provider].period === 'month'
    ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

/** `fripon:credits:v1:<provider>:<periodId>` */
export function creditsKey(provider: Provider, now: Date): string {
  return `${CREDITS_KEY_PREFIX}${provider}:${periodId(provider, now)}`;
}

/** Pure: where `used` stands against `cap` (null = no cap, never warns). */
export function usageState(used: number, cap: number | null): UsageState {
  if (cap === null) return 'ok';
  if (used >= cap) return 'reached';
  // The epsilon keeps a float product such as 0.8 * 55 from rounding the threshold up.
  if (used >= Math.ceil(cap * WARN_RATIO - 1e-9)) return 'warning';
  return 'ok';
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Credits spent so far in the current period of `provider`, against `cap`. */
export async function getUsage(
  provider: Provider,
  cap: number | null,
  now: Date = new Date(),
): Promise<Usage> {
  const key = creditsKey(provider, now);
  const used = readCount((await browser.storage.local.get(key))[key]);
  return { used, cap, state: usageState(used, cap), resetsAt: nextReset(provider, now) };
}

// Read-modify-write is not atomic: calls made from this context are serialised so two spends
// recorded together are both counted. Only the background records spends.
let pending: Promise<unknown> = Promise.resolve();

async function spend(provider: Provider, units: number, now: Date): Promise<number> {
  const key = creditsKey(provider, now);
  const total = readCount((await browser.storage.local.get(key))[key]) + units;
  await browser.storage.local.set({ [key]: total });
  // Counters of older periods are dead weight: drop this provider's (never another one's).
  const prefix = `${CREDITS_KEY_PREFIX}${provider}:`;
  const all = await browser.storage.local.get(null);
  const stale = isRecord(all)
    ? Object.keys(all).filter((k) => k.startsWith(prefix) && k !== key)
    : [];
  if (stale.length > 0) await browser.storage.local.remove(stale);
  return total;
}

/** Adds `units` to the current period's counter of `provider`; resolves to the new total. */
export function recordSpend(
  provider: Provider,
  units = 1,
  now: Date = new Date(),
): Promise<number> {
  if (!Number.isInteger(units) || units < 1) {
    return Promise.reject(new RangeError('units must be a positive integer'));
  }
  const run = pending.then(() => spend(provider, units, now));
  pending = run.catch(() => undefined);
  return run;
}
