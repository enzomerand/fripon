import { CODE_WINDOW_MS, SESSION_IDLE_MS } from './auth';
import type { Db } from './db';

/** Stripe retries an event for a few days: remembering it a month is plenty to spot a repeat. */
export const STRIPE_EVENT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Drops what has no use any more: expired cache entries, sign-in codes whose throttle window is
 * over, sessions nobody used for 90 days, and old webhook events. `main.ts` calls it every hour.
 */
export function purgeExpired(db: Db, now: number): void {
  db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM login_codes WHERE expires_at <= ? AND window_start <= ?').run(
    now,
    now - CODE_WINDOW_MS,
  );
  db.prepare('DELETE FROM sessions WHERE last_used_at <= ?').run(now - SESSION_IDLE_MS);
  db.prepare('DELETE FROM stripe_events WHERE received_at <= ?').run(now - STRIPE_EVENT_KEEP_MS);
}
