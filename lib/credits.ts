import { browser } from 'wxt/browser';
import { isRecord } from './json';
import { withLock } from './lock';
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

/**
 * Prefix of the `storage.local` counters: `<prefix><provider>:<periodId>`.
 *
 * The counter is per provider on purpose, not per key or per model: Fripon counts the calls it
 * makes, and one provider is one free-tier budget for the user. Lot 4 may refine Gemini per model
 * (each model has its own daily quota) by adding the model to the key.
 */
export const CREDITS_KEY_PREFIX = 'fripon:credits:v1:';

/** Name of the lock that serialises every counter write. */
export const CREDITS_LOCK = 'fripon:credits';

/** Google's quotas reset at midnight Pacific time, so the counters do too. */
const GOOGLE_TIME_ZONE = 'America/Los_Angeles';

export type UsageState = 'ok' | 'warning' | 'reached';

export interface Usage {
  used: number;
  /** null = no cap. */
  cap: number | null;
  /** Credits left before the cap (never below 0), null without a cap. */
  remaining: number | null;
  state: UsageState;
  /** When the counter starts again from zero (a midnight in Pacific time). */
  resetsAt: Date;
}

// ---- Periods, in Pacific time -----------------------------------------------------------------

const pacificFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: GOOGLE_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** The Pacific wall-clock reading of an instant (`month` is 1-based). */
function pacificWall(date: Date) {
  const parts: Record<string, number> = {};
  for (const part of pacificFormat.formatToParts(date)) parts[part.type] = Number(part.value);
  return {
    year: parts.year ?? NaN,
    month: parts.month ?? NaN,
    day: parts.day ?? NaN,
    hour: parts.hour ?? NaN,
    minute: parts.minute ?? NaN,
    second: parts.second ?? NaN,
  };
}

/**
 * The instant at which the Pacific clock reads 00:00 on that date. `Date.UTC` rolls overflowing
 * months and days over, so `day + 1` and `monthIndex + 1` need no special case. Daylight saving
 * changes happen at 02:00, so midnight always exists exactly once.
 */
function pacificMidnight(year: number, monthIndex: number, day: number): Date {
  const guess = Date.UTC(year, monthIndex, day);
  // Offset of the Pacific clock from UTC at an instant (negative: -7 h in summer, -8 h in winter).
  const offsetAt = (instant: number) => {
    const wall = pacificWall(new Date(instant));
    return (
      Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - instant
    );
  };
  // The first pass can be off by the one hour a daylight saving change moves the clock.
  const firstPass = guess - offsetAt(guess);
  return new Date(guess - offsetAt(firstPass));
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `YYYY-MM` (monthly provider) or `YYYY-MM-DD` (daily provider), on the Pacific calendar. */
export function periodId(provider: Provider, now: Date): string {
  const { year, month, day } = pacificWall(now);
  const monthId = `${pad(year, 4)}-${pad(month)}`;
  return CREDIT_POLICY[provider].period === 'month' ? monthId : `${monthId}-${pad(day)}`;
}

/** The first Pacific midnight after `now` that starts a new period for this provider. */
export function nextReset(provider: Provider, now: Date): Date {
  const { year, month, day } = pacificWall(now);
  return CREDIT_POLICY[provider].period === 'month'
    ? pacificMidnight(year, month, 1)
    : pacificMidnight(year, month - 1, day + 1);
}

/** `fripon:credits:v1:<provider>:<periodId>` */
function creditsKeyFor(provider: Provider, period: string): string {
  return `${CREDITS_KEY_PREFIX}${provider}:${period}`;
}

export function creditsKey(provider: Provider, now: Date): string {
  return creditsKeyFor(provider, periodId(provider, now));
}

// ---- Reading ----------------------------------------------------------------------------------

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

/**
 * Credits spent so far in the current period of `provider`, against `cap`. For display: to spend
 * credits, `reserve` checks and counts in one step.
 */
export async function getUsage(
  provider: Provider,
  cap: number | null,
  now: Date = new Date(),
): Promise<Usage> {
  const key = creditsKey(provider, now);
  const used = readCount((await browser.storage.local.get(key))[key]);
  return {
    used,
    cap,
    remaining: cap === null ? null : Math.max(0, cap - used),
    state: usageState(used, cap),
    resetsAt: nextReset(provider, now),
  };
}

// ---- Writing (background only) ----------------------------------------------------------------

function assertUnits(units: number) {
  if (!Number.isInteger(units) || units < 1)
    throw new RangeError('units must be a positive integer');
}

/** Removes this provider's counters of earlier periods (never another provider's, never later ones). */
async function purgeOlderPeriods(provider: Provider, now: Date) {
  const prefix = `${CREDITS_KEY_PREFIX}${provider}:`;
  const current = periodId(provider, now);
  const all = await browser.storage.local.get(null);
  // Period ids are zero-padded, so comparing them as strings compares them as dates.
  const stale = isRecord(all)
    ? Object.keys(all).filter((k) => k.startsWith(prefix) && k.slice(prefix.length) < current)
    : [];
  if (stale.length > 0) await browser.storage.local.remove(stale);
}

export type Reservation =
  /**
   * The credits are counted: go ahead and call Google. `remaining` is null without a cap.
   * `periodId` is the period they were charged to: pass it to `refund`.
   */
  | { ok: true; remaining: number | null; periodId: string }
  /** Nothing is counted and the call must not be made. */
  | { ok: false; remaining: number };

/**
 * Checks the cap AND counts `units` credits in one step, so two calls racing for the last credit
 * cannot both get it. Call it before every paid Google call, from the background, with the cap
 * from the stored settings: never trust a gate read earlier. If the call then fails for a reason
 * that cost nothing, give the credits back with `refund`.
 */
export function reserve(
  provider: Provider,
  units: number,
  cap: number | null,
  now?: Date,
): Promise<Reservation> {
  try {
    assertUnits(units);
    if (cap !== null && !(Number.isInteger(cap) && cap >= 0)) {
      throw new RangeError('cap must be null or a non-negative integer');
    }
  } catch (error) {
    return Promise.reject(error);
  }
  return withLock(CREDITS_LOCK, async () => {
    // Read inside the lock: the wait for it may have crossed midnight.
    const at = now ?? new Date();
    const key = creditsKey(provider, at);
    const stored = await browser.storage.local.get(key);
    const used = readCount(stored[key]);
    if (cap !== null && used + units > cap)
      return { ok: false, remaining: Math.max(0, cap - used) };
    await browser.storage.local.set({ [key]: used + units });
    // Only a new period's first spend can leave old counters behind.
    if (stored[key] === undefined) await purgeOlderPeriods(provider, at);
    return {
      ok: true,
      remaining: cap === null ? null : cap - used - units,
      periodId: periodId(provider, at),
    };
  });
}

/**
 * Gives back credits reserved for a call that failed without costing anything. `period` is the
 * `periodId` that `reserve` returned: the credits go back to the period they were taken from,
 * even if midnight has passed since.
 */
export function refund(provider: Provider, units: number, period: string): Promise<void> {
  try {
    assertUnits(units);
  } catch (error) {
    return Promise.reject(error);
  }
  return withLock(CREDITS_LOCK, async () => {
    const key = creditsKeyFor(provider, period);
    const stored = await browser.storage.local.get(key);
    // No counter for that period (already purged): nothing to give back.
    if (stored[key] === undefined) return;
    await browser.storage.local.set({ [key]: Math.max(0, readCount(stored[key]) - units) });
  });
}
