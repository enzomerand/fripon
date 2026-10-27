import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { TRIAL_ANALYSES } from './plans';
import { CODE_TTL_MINUTES, type Mailer } from './mailer';
import type { Account, Db } from './db';

/** Sign-in by e-mail code, then a bearer token. Nothing secret is stored in clear: a code is an
 *  HMAC keyed by `AUTH_SECRET`, a token is a SHA-256. */

export const CODE_TTL_MS = CODE_TTL_MINUTES * 60 * 1000;
/** Window of the send throttle. */
export const CODE_WINDOW_MS = 15 * 60 * 1000;
/** Codes sent to one address per window; beyond that a request is silently ignored. */
export const CODE_SENDS_PER_WINDOW = 3;
/** Wrong guesses a code survives. */
export const CODE_MAX_ATTEMPTS = 5;
/** Signed-in browsers per account; signing in on a fourth one signs the oldest out. */
export const MAX_SESSIONS = 3;
/** A session nobody used for this long stops working. */
export const SESSION_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** `last_used_at` moves at most this often: authenticating is a read, not a write per request. */
const LAST_USED_RESOLUTION_MS = 60 * 1000;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,100}$/;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The address in its stored form (trimmed, lower case), or null if it is not an e-mail address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) return null;
  // The local part is limited to 64 characters (RFC 5321); control characters never belong.
  const local = email.slice(0, email.lastIndexOf('@'));
  if (local.length > 64 || hasControlCharacter(email)) return null;
  return email;
}

export interface Auth {
  /**
   * Sends a 6-digit code to the address. Answers the same whether or not it sent one (throttled,
   * or an account exists or not): the route must not reveal anything. Throws only if the mail
   * itself could not be sent.
   */
  requestCode(email: string): Promise<void>;
  /** A new session token when the code is right, null otherwise. Creates the account at first. */
  verifyCode(email: string, code: string): { token: string; account: Account } | null;
  /** The account a token belongs to, null for an unknown, expired or malformed token. */
  authenticate(token: string): Account | null;
  /** Ends the session of this token (already ended is fine). */
  logout(token: string): void;
}

export interface AuthDeps {
  db: Db;
  mailer: Mailer;
  /** `AUTH_SECRET`. */
  secret: string;
  now: () => Date;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function createAuth({ db, mailer, secret, now }: AuthDeps): Auth {
  const codeHash = (email: string, code: string) =>
    createHmac('sha256', secret).update(`${email}\n${code}`).digest('hex');

  /** Stores a fresh code for the address and returns it, or null when the throttle says no. */
  const issueCode = db.transaction((email: string, at: number): string | null => {
    const previous = db
      .prepare('SELECT window_start, sends FROM login_codes WHERE email = ?')
      .get(email) as { window_start: number; sends: number } | undefined;

    const inWindow = previous !== undefined && at - previous.window_start < CODE_WINDOW_MS;
    if (inWindow && previous.sends >= CODE_SENDS_PER_WINDOW) return null;
    const windowStart = inWindow ? previous.window_start : at;
    const sends = inWindow ? previous.sends + 1 : 1;

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    db.prepare(
      `INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at, window_start, sends)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash,
         expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at,
         window_start = excluded.window_start, sends = excluded.sends`,
    ).run(email, codeHash(email, code), at + CODE_TTL_MS, at, windowStart, sends);
    return code;
  });

  const checkCode = db.transaction((email: string, code: string, at: number): boolean => {
    const row = db
      .prepare('SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?')
      .get(email) as { code_hash: string; expires_at: number; attempts: number } | undefined;
    if (!row || row.expires_at <= at || row.attempts >= CODE_MAX_ATTEMPTS) return false;

    // The guess is counted before it is compared, so nothing can skip the count.
    db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
    const expected = Buffer.from(row.code_hash, 'hex');
    const given = Buffer.from(codeHash(email, code), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;

    db.prepare('DELETE FROM login_codes WHERE email = ?').run(email);
    return true;
  });

  const openSession = db.transaction((email: string, at: number) => {
    db.prepare(
      'INSERT INTO accounts (id, email, created_at, trial_left) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING',
    ).run(randomUUID(), email, at, TRIAL_ANALYSES);
    const account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email) as Account;

    const token = randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO sessions (token_hash, account_id, created_at, last_used_at) VALUES (?, ?, ?, ?)',
    ).run(sha256(token), account.id, at, at);
    // Keep the newest sessions only (rowid breaks a tie between two in the same millisecond).
    db.prepare(
      `DELETE FROM sessions WHERE account_id = ? AND token_hash NOT IN (
         SELECT token_hash FROM sessions WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`,
    ).run(account.id, account.id, MAX_SESSIONS);
    return { token, account };
  });

  return {
    async requestCode(rawEmail) {
      const email = normalizeEmail(rawEmail);
      if (email === null) return;
      const code = issueCode.immediate(email, now().getTime());
      if (code !== null) await mailer.sendCode(email, code);
    },

    verifyCode(rawEmail, code) {
      const email = normalizeEmail(rawEmail);
      if (email === null) return null;
      const at = now().getTime();
      // Both steps in one transaction: a code can open one session at most.
      return db
        .transaction(() => (checkCode(email, code, at) ? openSession(email, at) : null))
        .immediate();
    },

    authenticate(token) {
      if (!TOKEN_SHAPE.test(token)) return null;
      const at = now().getTime();
      const row = db
        .prepare(
          `SELECT s.last_used_at AS last_used_at, a.* FROM sessions s
           JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`,
        )
        .get(sha256(token)) as (Account & { last_used_at: number }) | undefined;
      if (!row) return null;
      const { last_used_at: lastUsedAt, ...account } = row;

      if (at - lastUsedAt >= SESSION_IDLE_MS) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
        return null;
      }
      if (at - lastUsedAt >= LAST_USED_RESOLUTION_MS) {
        db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?').run(
          at,
          sha256(token),
        );
      }
      return account;
    },

    logout(token) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    },
  };
}
