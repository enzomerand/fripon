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
import { canonicalEmail, trialClaimKey } from './email';

/** Sign-in by e-mail code, then a bearer token. Nothing secret is stored in clear: a code is an
 *  HMAC keyed by `AUTH_SECRET`, a token is a SHA-256. */

export const CODE_TTL_MS = CODE_TTL_MINUTES * 60 * 1000;
/** Window of the send throttle. */
export const CODE_WINDOW_MS = 15 * 60 * 1000;
/** Codes sent to one address per window; beyond that a request is silently ignored. */
export const CODE_SENDS_PER_WINDOW = 3;
/** Wrong guesses a code survives. */
export const CODE_MAX_ATTEMPTS = 5;
/** Rolling window of the per-address cap on wrong guesses (a new code does not reset it). */
export const LOGIN_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Wrong guesses an address takes in that window from one client (an IPv4 address, an IPv6 /64
 * prefix), all its codes together; beyond that every verification from that client answers like a
 * wrong code until the oldest guess leaves the window. Without it, 3 codes per 15 minutes x 5
 * guesses each would let someone grind through a day of guesses. It is per client so that somebody
 * else guessing at an address cannot lock its owner out from their own line.
 */
export const LOGIN_FAILURES_PER_WINDOW = 10;
/**
 * Wrong guesses an address takes in that window whatever the client: what many addresses (a
 * botnet, a rented /48) together may try at one mailbox. Past it, every verification of that
 * address answers like a wrong code, from anywhere.
 */
export const LOGIN_FAILURES_PER_EMAIL_PER_WINDOW = 50;
/** Window of the cap on accounts created from one client address. */
export const SIGNUP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Accounts one address may create per window with a trial; the next ones start without one. */
export const SIGNUPS_PER_IP_PER_WINDOW = 3;
/** How long a mailbox remembers that its free trial was used, account deleted or not. */
export const TRIAL_CLAIM_KEEP_MS = 365 * 24 * 60 * 60 * 1000;
/** Signed-in browsers per account; signing in on a fourth one signs the oldest out. */
export const MAX_SESSIONS = 3;
/** A session nobody used for this long stops working. */
export const SESSION_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** A session never lives longer than this, however often it is used: a token stolen once ends. */
export const SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
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
  /**
   * A new session token when the code is right, null otherwise. Creates the account at first, with
   * the free trial unless the same mailbox (see `canonicalEmail`) already has an account or a
   * trial claim (an account of it was created with the trial, even if it was deleted since: see
   * `TRIAL_CLAIM_KEEP_MS`), or `clientIp` already created `SIGNUPS_PER_IP_PER_WINDOW` accounts in
   * a day. `clientIp` is null when the caller cannot tell (the cap then does not apply).
   */
  verifyCode(
    email: string,
    code: string,
    clientIp?: string | null,
  ): { token: string; account: Account } | null;
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
  /** Client addresses are stored as a keyed hash: personal data the server only needs to count. */
  const ipHash = (ip: string) => createHmac('sha256', secret).update(`ip\n${ip}`).digest('hex');

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

  const checkCode = db.transaction(
    (email: string, code: string, at: number, hashedIp: string): boolean => {
      // Locked: too many wrong guesses on this address today, from this client or from all of them.
      // Nothing more is counted, so the lock ends when the oldest guess leaves the window, and the
      // answer is a plain wrong code.
      const failures = db
        .prepare(
          `SELECT COUNT(*) AS total, COALESCE(SUM(ip_hash = ?), 0) AS here
         FROM login_failures WHERE email = ? AND at > ?`,
        )
        .get(hashedIp, email, at - LOGIN_FAILURE_WINDOW_MS) as { total: number; here: number };
      if (failures.here >= LOGIN_FAILURES_PER_WINDOW) return false;
      if (failures.total >= LOGIN_FAILURES_PER_EMAIL_PER_WINDOW) return false;

      const row = db
        .prepare('SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?')
        .get(email) as { code_hash: string; expires_at: number; attempts: number } | undefined;
      if (!row || row.expires_at <= at || row.attempts >= CODE_MAX_ATTEMPTS) return false;

      // The guess is counted before it is compared, so nothing can skip the count.
      db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
      const expected = Buffer.from(row.code_hash, 'hex');
      const given = Buffer.from(codeHash(email, code), 'hex');
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        db.prepare('INSERT INTO login_failures (email, ip_hash, at) VALUES (?, ?, ?)').run(
          email,
          hashedIp,
          at,
        );
        return false;
      }

      db.prepare('DELETE FROM login_codes WHERE email = ?').run(email);
      return true;
    },
  );

  /** Analyses of the trial for an account about to be created: none for a known mailbox or a busy address. */
  function trialFor(canonical: string, hashedIp: string | null, at: number): number {
    const sameMailbox = db
      .prepare('SELECT 1 FROM accounts WHERE canonical_email = ? LIMIT 1')
      .get(canonical);
    if (sameMailbox) return 0;
    // The mailbox had its trial on an account that is gone since.
    const claimed = db
      .prepare('SELECT 1 FROM trial_claims WHERE key = ?')
      .get(trialClaimKey(secret, canonical));
    if (claimed) return 0;
    if (hashedIp !== null) {
      const created = db
        .prepare('SELECT COUNT(*) AS n FROM signups WHERE ip_hash = ? AND at > ?')
        .get(hashedIp, at - SIGNUP_WINDOW_MS) as { n: number };
      if (created.n >= SIGNUPS_PER_IP_PER_WINDOW) return 0;
    }
    return TRIAL_ANALYSES;
  }

  const openSession = db.transaction((email: string, at: number, clientIp: string | null) => {
    let account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email) as
      Account | undefined;
    if (!account) {
      const canonical = canonicalEmail(email);
      const hashedIp = clientIp === null ? null : ipHash(clientIp);
      const id = randomUUID();
      const trial = trialFor(canonical, hashedIp, at);
      db.prepare(
        'INSERT INTO accounts (id, email, created_at, trial_left, canonical_email) VALUES (?, ?, ?, ?, ?)',
      ).run(id, email, at, trial, canonical);
      if (trial > 0) {
        // Kept when the account is deleted: this is what stops a second trial for the mailbox.
        db.prepare('INSERT OR IGNORE INTO trial_claims (key, created_at) VALUES (?, ?)').run(
          trialClaimKey(secret, canonical),
          at,
        );
      }
      if (hashedIp !== null) {
        db.prepare('INSERT INTO signups (ip_hash, at) VALUES (?, ?)').run(hashedIp, at);
      }
      account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account;
    }

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

    verifyCode(rawEmail, code, clientIp = null) {
      const email = normalizeEmail(rawEmail);
      if (email === null) return null;
      const at = now().getTime();
      // A client that cannot be told counts as one client of its own (the empty hash).
      const hashedIp = clientIp === null ? '' : ipHash(clientIp);
      // Both steps in one transaction: a code can open one session at most.
      return db
        .transaction(() =>
          checkCode(email, code, at, hashedIp) ? openSession(email, at, clientIp) : null,
        )
        .immediate();
    },

    authenticate(token) {
      if (!TOKEN_SHAPE.test(token)) return null;
      const at = now().getTime();
      const row = db
        .prepare(
          `SELECT s.last_used_at AS last_used_at, s.created_at AS session_created_at, a.*
           FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`,
        )
        .get(sha256(token)) as
        (Account & { last_used_at: number; session_created_at: number }) | undefined;
      if (!row) return null;
      const { last_used_at: lastUsedAt, session_created_at: sessionCreatedAt, ...account } = row;

      if (at - lastUsedAt >= SESSION_IDLE_MS || at - sessionCreatedAt >= SESSION_MAX_AGE_MS) {
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
