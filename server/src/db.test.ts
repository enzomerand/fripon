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
      'trial_claims',
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
