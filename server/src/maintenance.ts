import {
  CODE_WINDOW_MS,
  LOGIN_FAILURE_WINDOW_MS,
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
  SIGNUP_WINDOW_MS,
  TRIAL_CLAIM_KEEP_MS,
} from './auth';
import type { Db } from './db';
import { periodIds } from './time';

/** Stripe retries an event for a few days: remembering it a month is plenty to spot a repeat. */
export const STRIPE_EVENT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** The month (`YYYY-MM`, Paris) before the one `now` falls in. */
export function previousMonth(now: Date): string {
  const [year, month] = periodIds(now).month.split('-').map(Number) as [number, number];
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/**
 * Drops what has no use any more, so the database holds no personal data longer than it needs:
 * expired cache entries, sign-in codes (an e-mail address) whose throttle window is over, wrong
 * guesses and sign-ups (a keyed hash of an address) out of their day, sessions nobody used for 90
 * days or older than a year, old webhook events, and the usage and review counters older than the
 * previous month (the current and the previous month stay; the quota and the review limit only
 * read the current one), and trial claims (a keyed hash of a mailbox) after 12 months. `main.ts`
 * calls it every hour.
 */
export function purgeExpired(db: Db, now: number): void {
  db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM login_codes WHERE expires_at <= ? AND window_start <= ?').run(
    now,
    now - CODE_WINDOW_MS,
  );
  db.prepare('DELETE FROM login_failures WHERE at <= ?').run(now - LOGIN_FAILURE_WINDOW_MS);
  db.prepare('DELETE FROM signups WHERE at <= ?').run(now - SIGNUP_WINDOW_MS);
  db.prepare('DELETE FROM sessions WHERE last_used_at <= ? OR created_at <= ?').run(
    now - SESSION_IDLE_MS,
    now - SESSION_MAX_AGE_MS,
  );
  db.prepare('DELETE FROM stripe_events WHERE received_at <= ?').run(now - STRIPE_EVENT_KEEP_MS);
  db.prepare('DELETE FROM trial_claims WHERE created_at <= ?').run(now - TRIAL_CLAIM_KEEP_MS);

  const keepFrom = previousMonth(new Date(now));
  db.prepare('DELETE FROM usage WHERE month < ?').run(keepFrom);
  db.prepare('DELETE FROM reviews WHERE month < ?').run(keepFrom);
}
