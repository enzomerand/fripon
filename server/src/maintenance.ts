import { CODE_WINDOW_MS, SESSION_IDLE_MS } from './auth';
import type { Db } from './db';

/**
 * Drops what has no use any more: expired cache entries, sign-in codes whose throttle window is
 * over, and sessions nobody used for 90 days. `main.ts` calls it every hour.
 */
export function purgeExpired(db: Db, now: number): void {
  db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM login_codes WHERE expires_at <= ? AND window_start <= ?').run(
    now,
    now - CODE_WINDOW_MS,
  );
  db.prepare('DELETE FROM sessions WHERE last_used_at <= ?').run(now - SESSION_IDLE_MS);
}
