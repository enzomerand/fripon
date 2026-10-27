import type { Db } from './db';

/**
 * The cache every account shares (table `cache`): a Vision answer or an AI review is paid once and
 * served to anyone who asks the same thing within its lifetime. Values are JSON text; what is read
 * back goes through the caller's `parse`, the one the extension uses for its own cache, so a
 * damaged row is a miss and never an error. `purgeExpired` drops what has expired.
 */
export interface SharedCache {
  /** The value stored for `key` and still alive at `now`, null when there is none or `parse` refuses it. */
  get<T>(key: string, now: number, parse: (raw: unknown) => T | null): T | null;
  /** Stores `value` for `ttlMs`, replacing any earlier one. */
  set(key: string, value: unknown, now: number, ttlMs: number): void;
}

export function createSharedCache(db: Db): SharedCache {
  const read = db.prepare('SELECT value FROM cache WHERE key = ? AND expires_at > ?');
  const write = db.prepare(
    `INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
  );

  return {
    get(key, now, parse) {
      const row = read.get(key, now) as { value: string } | undefined;
      if (!row) return null;
      try {
        return parse(JSON.parse(row.value));
      } catch {
        return null;
      }
    },
    set(key, value, now, ttlMs) {
      write.run(key, JSON.stringify(value), now + ttlMs);
    },
  };
}
