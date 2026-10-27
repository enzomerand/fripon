import { beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_WINDOW_MS,
  LOGIN_FAILURE_WINDOW_MS,
  SESSION_MAX_AGE_MS,
  SIGNUP_WINDOW_MS,
  TRIAL_CLAIM_KEEP_MS,
} from './auth';
import { openDb, type Db } from './db';
import { previousMonth, purgeExpired } from './maintenance';
import { fakeClock, insertAccount, type Clock } from './test-helpers';

let db: Db;
let clock: Clock;

beforeEach(() => {
  db = openDb(':memory:');
  // 14:00 in Paris on 20 October 2026.
  clock = fakeClock('2026-10-20T12:00:00Z');
});

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('previousMonth', () => {
  it('is the month before the one Paris is in, over a year end too', () => {
    expect(previousMonth(new Date('2026-10-20T12:00:00Z'))).toBe('2026-09');
    expect(previousMonth(new Date('2026-01-15T12:00:00Z'))).toBe('2025-12');
    // 00:30 on 1 November in Paris is still 31 October in UTC.
    expect(previousMonth(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10');
  });
});

describe('purgeExpired: what the database does not keep', () => {
  it('drops usage and review counters older than the previous month, keeps the previous and the current one', () => {
    const { id } = insertAccount(db);
    const usage = db.prepare(
      "INSERT INTO usage (account_id, photo_key, month, day, kind, served_at) VALUES (?, ?, ?, '2026-01-01', 'plan', 0)",
    );
    const review = db.prepare(
      'INSERT INTO reviews (account_id, photo_key, month, count, last_at) VALUES (?, ?, ?, 1, 0)',
    );
    for (const month of ['2026-07', '2026-08', '2026-09', '2026-10']) {
      usage.run(id, `p-${month}`, month);
      review.run(id, `p-${month}`, month);
    }

    purgeExpired(db, clock.ms());

    for (const table of ['usage', 'reviews']) {
      expect(
        (db.prepare(`SELECT month FROM ${table} ORDER BY month`).all() as { month: string }[]).map(
          (row) => row.month,
        ),
      ).toEqual(['2026-09', '2026-10']);
    }
  });

  it('reads the previous month in Paris, across a year end', () => {
    const { id } = insertAccount(db);
    db.prepare(
      "INSERT INTO usage (account_id, photo_key, month, day, kind, served_at) VALUES (?, 'a', '2025-11', '2025-11-02', 'plan', 0)",
    ).run(id);
    db.prepare(
      "INSERT INTO usage (account_id, photo_key, month, day, kind, served_at) VALUES (?, 'b', '2025-12', '2025-12-02', 'plan', 0)",
    ).run(id);

    purgeExpired(db, new Date('2026-01-10T12:00:00Z').getTime());

    expect(db.prepare('SELECT photo_key FROM usage').all()).toEqual([{ photo_key: 'b' }]);
  });

  it('drops the keyed hashes of client addresses once their day is over, and not before', () => {
    db.prepare('INSERT INTO signups (ip_hash, at) VALUES (?, ?)').run(
      'old',
      clock.ms() - SIGNUP_WINDOW_MS,
    );
    db.prepare('INSERT INTO signups (ip_hash, at) VALUES (?, ?)').run(
      'new',
      clock.ms() - SIGNUP_WINDOW_MS + 1,
    );
    db.prepare('INSERT INTO login_failures (email, ip_hash, at) VALUES (?, ?, ?)').run(
      'a@b.c',
      'old',
      clock.ms() - LOGIN_FAILURE_WINDOW_MS,
    );
    db.prepare('INSERT INTO login_failures (email, ip_hash, at) VALUES (?, ?, ?)').run(
      'a@b.c',
      'new',
      clock.ms() - LOGIN_FAILURE_WINDOW_MS + 1,
    );

    purgeExpired(db, clock.ms());

    expect(db.prepare('SELECT ip_hash FROM signups').all()).toEqual([{ ip_hash: 'new' }]);
    expect(db.prepare('SELECT ip_hash FROM login_failures').all()).toEqual([{ ip_hash: 'new' }]);
  });

  it('drops trial claims after 12 months, and not before', () => {
    const insert = db.prepare('INSERT INTO trial_claims (key, created_at) VALUES (?, ?)');
    insert.run('old', clock.ms() - TRIAL_CLAIM_KEEP_MS);
    insert.run('young', clock.ms() - TRIAL_CLAIM_KEEP_MS + 1);

    purgeExpired(db, clock.ms());

    expect(db.prepare('SELECT key FROM trial_claims').all()).toEqual([{ key: 'young' }]);
  });

  it('drops sign-in codes once their throttle window is over', () => {
    const insert = db.prepare(
      'INSERT INTO login_codes (email, code_hash, expires_at, sent_at, window_start) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run('gone@b.c', 'h', clock.ms() - 1, 0, clock.ms() - CODE_WINDOW_MS);
    insert.run('throttled@b.c', 'h', clock.ms() - 1, 0, clock.ms() - CODE_WINDOW_MS + 1);
    insert.run('live@b.c', 'h', clock.ms() + 60_000, 0, clock.ms() - CODE_WINDOW_MS);

    purgeExpired(db, clock.ms());

    expect(
      (db.prepare('SELECT email FROM login_codes ORDER BY email').all() as { email: string }[]).map(
        (row) => row.email,
      ),
    ).toEqual(['live@b.c', 'throttled@b.c']);
  });

  it('drops a session a year old even if it was used yesterday, and keeps a younger one', () => {
    const { id } = insertAccount(db);
    const insert = db.prepare(
      'INSERT INTO sessions (token_hash, account_id, created_at, last_used_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('year', id, clock.ms() - SESSION_MAX_AGE_MS, clock.ms() - 86_400_000);
    insert.run('young', id, clock.ms() - SESSION_MAX_AGE_MS + 1, clock.ms() - 86_400_000);

    purgeExpired(db, clock.ms());

    expect(db.prepare('SELECT token_hash FROM sessions').all()).toEqual([{ token_hash: 'young' }]);
    expect(count('accounts')).toBe(1);
  });
});
