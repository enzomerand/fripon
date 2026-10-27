import { browser } from 'wxt/browser';
import { withLock } from './lock';

/** How a cache of `storage.local` entries is laid out; every entry carries the time it was written. */
interface TtlCacheConfig<E extends { at: number }> {
  /** Every key of the cache starts with it (`fripon:vision:v1:`...). */
  prefix: string;
  /** An entry older than this (ms) counts as missing. */
  ttlMs: number;
  /** The cache never keeps more entries than this (the oldest go first). */
  maxEntries: number;
  /** Name of the lock that serialises the writes. */
  lockName: string;
  /** The entry that `raw` holds, null for anything that is not what this cache writes. */
  parse(raw: unknown): E | null;
}

export interface TtlCache<E extends { at: number }> {
  /** The entry stored for `key`, null when there is none, it expired, or it is damaged. */
  read(key: string, now: number): Promise<E | null>;
  /** Stores `entry` (dated `entry.at`), then keeps the cache within its limits. */
  write(key: string, entry: E): Promise<void>;
}

/**
 * A cache in `storage.local` where entries expire after a while and the oldest are dropped past a
 * limit. The caller owns the shape of an entry and the key (it must start with `config.prefix`).
 * Both the Vision and the AI review caches are built on it.
 */
export function createTtlCache<E extends { at: number }>(config: TtlCacheConfig<E>): TtlCache<E> {
  const { prefix, ttlMs, maxEntries, lockName, parse } = config;

  /**
   * Drops the expired and damaged entries, then the oldest ones above the limit. `latest` is the
   * entry just written: it is the last to go, even on a tie.
   */
  async function prune(latest: string, now: number): Promise<void> {
    const all = await browser.storage.local.get(null);
    const entries = Object.keys(all)
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, at: parse(all[key])?.at ?? -Infinity }));

    const stale = entries.filter((entry) => now - entry.at > ttlMs);
    const fresh = entries
      .filter((entry) => !stale.includes(entry))
      .sort((a, b) => b.at - a.at || Number(b.key === latest) - Number(a.key === latest));
    const overflow = fresh.slice(maxEntries);

    const doomed = [...stale, ...overflow].map((entry) => entry.key);
    if (doomed.length > 0) await browser.storage.local.remove(doomed);
  }

  return {
    async read(key, now) {
      const entry = parse((await browser.storage.local.get(key))[key]);
      return !entry || now - entry.at > ttlMs ? null : entry;
    },
    write(key, entry) {
      return withLock(lockName, async () => {
        await browser.storage.local.set({ [key]: entry });
        await prune(key, entry.at);
      });
    },
  };
}
