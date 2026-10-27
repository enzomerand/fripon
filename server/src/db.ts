import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalEmail } from './email';
import { dropSizeSegment } from './photo-key';
import { periodIds } from './time';

export type Db = Database.Database;

/**
 * A row of `accounts`. Every timestamp of the database is a number of milliseconds since the epoch
 * (Stripe's seconds are converted by the billing code, `period_end` included).
 */
export interface Account {
  id: string;
  email: string;
  created_at: number;
  /** Analyses left of the free trial (one-off, no card). */
  trial_left: number;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  /** `essentiel` or `revendeur` (see `plans.ts`); null before any subscription. */
  plan: string | null;
  /** Stripe's own word: `active`, `trialing`, `past_due`, `canceled`... */
  subscription_status: string | null;
  period_end: number | null;
  /**
   * The address without its cosmetic variants (see `canonicalEmail`): what tells that two accounts
   * are one mailbox. Not unique: a second account is allowed, it just gets no trial.
   */
  canonical_email: string;
}

/** A migration: SQL, or a function when it also has to compute (a backfill). */
type Migration = string | ((db: Db) => void);

/**
 * The schema, one entry per version: `PRAGMA user_version` holds how many have run. Never edit an
 * entry that shipped, add a new one. Each entry runs in its own transaction.
 */
const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    trial_left INTEGER NOT NULL DEFAULT 15,
    stripe_customer_id TEXT UNIQUE,
    subscription_id TEXT,
    plan TEXT,
    subscription_status TEXT,
    period_end INTEGER
  );

  -- One live code per email. window_start and sends throttle the sends (3 per 15 minutes); the
  -- row outlives the code's expiry on purpose, or a throttled address could be reset by verifying.
  CREATE TABLE login_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    sends INTEGER NOT NULL DEFAULT 1
  );

  -- Only the SHA-256 of a token is stored: a copy of the database signs nobody in.
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_by_account ON sessions (account_id);

  -- One row = one analysis served to an account (a photo, once a month). A row's existence is what
  -- makes the same photo free for the rest of the month and lets the AI review run.
  CREATE TABLE usage (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    photo_key TEXT NOT NULL,
    month TEXT NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('plan', 'trial')),
    served_at INTEGER NOT NULL,
    UNIQUE (account_id, photo_key, month)
  );
  CREATE INDEX usage_by_month ON usage (account_id, month, kind);
  CREATE INDEX usage_by_day ON usage (account_id, day, kind);

  CREATE TABLE reviews (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    photo_key TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    last_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, photo_key)
  );

  -- Shared by every account (Vision answers, AI reviews).
  CREATE TABLE cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX cache_by_expiry ON cache (expires_at);

  -- Webhook events already handled (Stripe delivers an event more than once).
  CREATE TABLE stripe_events (
    id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL
  );

  -- Paid Vision calls per day, all accounts together: the global ceiling.
  CREATE TABLE vision_calls (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );
  `,
  (db) => {
    db.exec(`
    -- The address without its cosmetic variants (+tag, Gmail dots): one trial per mailbox.
    ALTER TABLE accounts ADD COLUMN canonical_email TEXT NOT NULL DEFAULT '';
    CREATE INDEX accounts_by_canonical_email ON accounts (canonical_email);

    -- Wrong guesses of a sign-in code, one row each: the per-address cap over a rolling day.
    CREATE TABLE login_failures (
      email TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX login_failures_by_email ON login_failures (email, at);

    -- Accounts created, one row each, by a keyed hash of the client address (never the address).
    CREATE TABLE signups (
      ip_hash TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX signups_by_ip ON signups (ip_hash, at);

    -- Paid Gemini calls per day, all accounts together: the global ceiling.
    CREATE TABLE gemini_calls (
      day TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );
    `);
    const update = db.prepare('UPDATE accounts SET canonical_email = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, email FROM accounts').all() as {
      id: string;
      email: string;
    }[]) {
      update.run(canonicalEmail(row.email), row.id);
    }
  },
  (db) => {
    db.exec(`
    -- A wrong guess of a sign-in code now also remembers where it came from (a keyed hash of the
    -- client's address prefix, never the address): 10 per address and prefix, 50 per address.
    ALTER TABLE login_failures ADD COLUMN ip_hash TEXT NOT NULL DEFAULT '';
    CREATE INDEX login_failures_by_email_ip ON login_failures (email, ip_hash, at);

    -- Vision calls served to accounts on their free trial, a part of the day's count: the trial
    -- may use a share of the global ceiling only.
    ALTER TABLE vision_calls ADD COLUMN trial_count INTEGER NOT NULL DEFAULT 0;

    -- Reviews are now counted per account, photo AND month (Paris), and only when the call really
    -- went to Gemini.
    CREATE TABLE reviews_by_month (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      photo_key TEXT NOT NULL,
      month TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      last_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, photo_key, month)
    );
    `);

    // The old counters go to the month of their last review. A photo key loses its size segment
    // (`/f800/`, `/310x430/`) like every new key does: one listing, one analysis.
    const insert = db.prepare(
      `INSERT INTO reviews_by_month (account_id, photo_key, month, count, last_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, photo_key, month) DO UPDATE SET
         count = count + excluded.count, last_at = MAX(last_at, excluded.last_at)`,
    );
    for (const row of db.prepare('SELECT * FROM reviews').all() as {
      account_id: string;
      photo_key: string;
      count: number;
      last_at: number;
    }[]) {
      insert.run(
        row.account_id,
        dropSizeSegment(row.photo_key),
        periodIds(new Date(row.last_at)).month,
        row.count,
        row.last_at,
      );
    }
    db.exec('DROP TABLE reviews; ALTER TABLE reviews_by_month RENAME TO reviews;');

    // OR IGNORE: two rows of one month that now share a key keep the old key of the second one.
    const rekey = db.prepare('UPDATE OR IGNORE usage SET photo_key = ? WHERE rowid = ?');
    for (const row of db.prepare('SELECT rowid AS id, photo_key FROM usage').all() as {
      id: number;
      photo_key: string;
    }[]) {
      const key = dropSizeSegment(row.photo_key);
      if (key !== row.photo_key) rekey.run(key, row.id);
    }
  },
];

/**
 * Brings the schema up to date; safe to call on every start. `upTo` stops at an older version, so a
 * test can build the database of an earlier release, fill it, and upgrade it.
 */
export function migrate(db: Db, upTo: number = MIGRATIONS.length): void {
  const current = Number(db.pragma('user_version', { simple: true }));
  for (let version = current; version < Math.min(upTo, MIGRATIONS.length); version++) {
    const migration = MIGRATIONS[version] as Migration;
    db.transaction(() => {
      if (typeof migration === 'string') db.exec(migration);
      else migration(db);
      // PRAGMA takes no bound parameter: `version` is a loop counter, never user input.
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

/** Opens the database (a file, or `:memory:` in tests) and brings its schema up to date. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Another connection holding a write lock makes this one wait instead of failing at once.
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

/** The account with that id, or null. */
export function getAccount(db: Db, id: string): Account | null {
  return (db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account | undefined) ?? null;
}
