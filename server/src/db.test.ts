import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from './db';
import { insertAccount } from './test-helpers';

const open: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const memory = () => {
  const db = openDb(':memory:');
  open.push(db);
  return db;
};

const tables = (db: Db) =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .sort();

describe('openDb', () => {
  it('creates every table', () => {
    expect(tables(memory())).toEqual([
      'accounts',
      'cache',
      'gemini_calls',
      'login_codes',
      'login_failures',
      'reviews',
      'sessions',
      'signups',
      'stripe_events',
      'usage',
      'vision_calls',
    ]);
  });

  it('versions the schema with user_version', () => {
    const db = memory();
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(1);
  });

  it('is safe to run again: nothing changes, data stays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fripon-db-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'fripon.db');

    const first = openDb(path); // creates the folder too
    open.push(first);
    const version = first.pragma('user_version', { simple: true });
    const account = insertAccount(first);
    first.close();

    const second = openDb(path);
    open.push(second);
    expect(second.pragma('user_version', { simple: true })).toBe(version);
    expect(second.prepare('SELECT id FROM accounts').all()).toEqual([{ id: account.id }]);
  });

  it('runs the migrations a database has not seen yet', () => {
    const raw = new Database(':memory:');
    expect(raw.pragma('user_version', { simple: true })).toBe(0);
    migrate(raw);
    expect(raw.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(1);
    expect(() => migrate(raw)).not.toThrow();
    raw.close();
  });

  it('uses WAL and enforces foreign keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fripon-db-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'fripon.db'));
    open.push(db);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBeGreaterThan(0);
  });
});

describe('schema', () => {
  it('starts an account with 15 trial analyses and no subscription', () => {
    const db = memory();
    db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('a', 'a@b.c', 1)").run();
    expect(db.prepare('SELECT * FROM accounts').get()).toEqual({
      id: 'a',
      email: 'a@b.c',
      created_at: 1,
      trial_left: 15,
      stripe_customer_id: null,
      subscription_id: null,
      plan: null,
      subscription_status: null,
      period_end: null,
      canonical_email: '',
    });
  });

  it('upgrades the database of the first release: canonical emails are filled in, data stays', () => {
    const raw = new Database(':memory:');
    migrate(raw, 1);
    expect(raw.pragma('user_version', { simple: true })).toBe(1);
    const insert = raw.prepare(
      'INSERT INTO accounts (id, email, created_at, trial_left) VALUES (?, ?, 5, ?)',
    );
    insert.run('a', 'Jo.Doe+x@googlemail.com', 7);
    insert.run('b', 'plain@example.com', 15);

    migrate(raw);

    expect(
      raw.prepare('SELECT id, email, trial_left, canonical_email FROM accounts ORDER BY id').all(),
    ).toEqual([
      {
        id: 'a',
        email: 'Jo.Doe+x@googlemail.com',
        trial_left: 7,
        canonical_email: 'jodoe@gmail.com',
      },
      { id: 'b', email: 'plain@example.com', trial_left: 15, canonical_email: 'plain@example.com' },
    ]);
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'accounts_by_canonical_email'",
        )
        .all(),
    ).toHaveLength(1);
    raw.close();
  });

  it('upgrades the database of the second release: reviews move to their month, photo keys lose their size', () => {
    const raw = new Database(':memory:');
    migrate(raw, 2);
    raw.pragma('foreign_keys = ON');
    raw.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('a', 'a@b.c', 1)").run();
    // 2026-10-20 12:00 UTC is October in Paris.
    const lastAt = Date.UTC(2026, 9, 20, 12);
    raw
      .prepare('INSERT INTO reviews (account_id, photo_key, count, last_at) VALUES (?, ?, ?, ?)')
      .run('a', 'https://images1.vinted.net/t/01_a/f800/1.jpeg', 2, lastAt);
    raw
      .prepare('INSERT INTO reviews (account_id, photo_key, count, last_at) VALUES (?, ?, ?, ?)')
      .run('a', 'https://images1.vinted.net/t/01_a/310x430/1.jpeg', 1, lastAt + 1000);
    const usage = raw.prepare(
      "INSERT INTO usage (account_id, photo_key, month, day, kind, served_at) VALUES ('a', ?, ?, '2026-10-20', 'plan', 0)",
    );
    usage.run('https://images1.vinted.net/t/01_a/f800/1.jpeg', '2026-10');
    usage.run('https://images1.vinted.net/t/01_b/f800/2.jpeg', '2026-10');
    usage.run('https://images1.vinted.net/t/01_b/310x430/2.jpeg', '2026-10');
    raw.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').run('a@b.c', 5);
    raw.prepare("INSERT INTO vision_calls (day, count) VALUES ('2026-10-20', 7)").run();

    migrate(raw);

    // The two sizes of one photo are one counter now, in the month of the last review.
    expect(raw.prepare('SELECT photo_key, month, count FROM reviews').all()).toEqual([
      { photo_key: 'https://images1.vinted.net/t/01_a/1.jpeg', month: '2026-10', count: 3 },
    ]);
    // The two sizes of the second photo collide: one takes the new key, the other keeps its old
    // one (which of the two depends on the order the rows are read in). Nothing is lost.
    const keys = (
      raw.prepare('SELECT photo_key FROM usage ORDER BY photo_key').all() as { photo_key: string }[]
    ).map((row) => row.photo_key);
    expect(keys).toHaveLength(3);
    expect(keys).toContain('https://images1.vinted.net/t/01_a/1.jpeg');
    expect(keys).toContain('https://images1.vinted.net/t/01_b/2.jpeg');
    expect(raw.prepare('SELECT ip_hash FROM login_failures').all()).toEqual([{ ip_hash: '' }]);
    expect(raw.prepare('SELECT count, trial_count FROM vision_calls').all()).toEqual([
      { count: 7, trial_count: 0 },
    ]);
    raw.close();
  });

  it('counts a review per account, photo and month', () => {
    const db = memory();
    const { id } = insertAccount(db);
    const insert = (photo: string, month: string) =>
      db
        .prepare(
          'INSERT INTO reviews (account_id, photo_key, month, count, last_at) VALUES (?, ?, ?, 1, 0)',
        )
        .run(id, photo, month);
    insert('p', '2026-10');
    expect(() => insert('p', '2026-10')).toThrow(/UNIQUE/);
    insert('p', '2026-11');
    insert('q', '2026-10');
  });

  it('keeps emails and Stripe customers unique', () => {
    const db = memory();
    insertAccount(db, { email: 'a@b.c', stripe_customer_id: 'cus_1' });
    expect(() => insertAccount(db, { email: 'a@b.c' })).toThrow(/UNIQUE/);
    expect(() => insertAccount(db, { stripe_customer_id: 'cus_1' })).toThrow(/UNIQUE/);
    // Several accounts may have no customer yet.
    insertAccount(db);
    insertAccount(db);
  });

  it('removes what belongs to an account with it', () => {
    const db = memory();
    const { id } = insertAccount(db);
    db.prepare(
      "INSERT INTO sessions (token_hash, account_id, created_at, last_used_at) VALUES ('h', ?, 0, 0)",
    ).run(id);
    db.prepare(
      "INSERT INTO usage (account_id, photo_key, month, day, kind, served_at) VALUES (?, 'p', '2026-10', '2026-10-20', 'plan', 0)",
    ).run(id);
    db.prepare(
      "INSERT INTO reviews (account_id, photo_key, month, count, last_at) VALUES (?, 'p', '2026-10', 1, 0)",
    ).run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    for (const table of ['sessions', 'usage', 'reviews']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it('refuses rows of an account that does not exist', () => {
    const db = memory();
    expect(() =>
      db
        .prepare(
          "INSERT INTO sessions (token_hash, account_id, created_at, last_used_at) VALUES ('h', 'ghost', 0, 0)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('counts a photo once per account and month, and knows only two kinds', () => {
    const db = memory();
    const { id } = insertAccount(db);
    const insert = (photo: string, month: string, kind = 'plan') =>
      db
        .prepare(
          "INSERT INTO usage (account_id, photo_key, month, day, kind, served_at) VALUES (?, ?, ?, '2026-10-20', ?, 0)",
        )
        .run(id, photo, month, kind);
    insert('p', '2026-10');
    expect(() => insert('p', '2026-10')).toThrow(/UNIQUE/);
    insert('p', '2026-11');
    insert('q', '2026-10');
    expect(() => insert('r', '2026-10', 'gift')).toThrow(/CHECK/);
  });
});
