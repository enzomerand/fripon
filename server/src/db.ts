import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

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
}

/**
 * The schema, one entry per version: `PRAGMA user_version` holds how many have run. Never edit an
 * entry that shipped, add a new one. Each entry runs in its own transaction.
 */
const MIGRATIONS: string[] = [
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
];

/** Brings the schema up to date; safe to call on every start. */
export function migrate(db: Db): void {
  const current = Number(db.pragma('user_version', { simple: true }));
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version] as string;
    db.transaction(() => {
      db.exec(sql);
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
