import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_MAX_ATTEMPTS,
  CODE_SENDS_PER_WINDOW,
  CODE_TTL_MS,
  CODE_WINDOW_MS,
  LOGIN_FAILURES_PER_WINDOW,
  LOGIN_FAILURE_WINDOW_MS,
  MAX_SESSIONS,
  SESSION_IDLE_MS,
  SIGNUPS_PER_IP_PER_WINDOW,
  SIGNUP_WINDOW_MS,
  createAuth,
  normalizeEmail,
  type Auth,
} from './auth';
import { openDb, type Db } from './db';
import { purgeExpired } from './maintenance';
import { fakeClock, fakeMailer, type Clock, type FakeMailer } from './test-helpers';

const SECRET = 'test-secret';
const EMAIL = 'sam@example.com';

let db: Db;
let clock: Clock;
let mailer: FakeMailer;
let auth: Auth;

beforeEach(() => {
  db = openDb(':memory:');
  clock = fakeClock();
  mailer = fakeMailer();
  auth = createAuth({ db, mailer, secret: SECRET, now: clock.now });
});

/** Asks for a code and returns it, as the mail carries it. */
async function codeFor(email = EMAIL): Promise<string> {
  const before = mailer.sent.length;
  await auth.requestCode(email);
  const sent = mailer.sent[before];
  if (!sent) throw new Error('no mail was sent');
  return sent.code;
}

/** A session token for the address. */
async function signIn(email = EMAIL): Promise<string> {
  const session = auth.verifyCode(email, await codeFor(email));
  if (!session) throw new Error('sign-in failed');
  return session.token;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const wrongCode = (code: string) => (code === '000000' ? '000001' : '000000');

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Sam@Example.COM ')).toBe('sam@example.com');
  });

  it.each([
    '',
    'sam',
    'sam@',
    '@example.com',
    'sam@example',
    'sam example@example.com',
    'sam@exa mple.com',
    'sam@@example.com',
    'sam\n@example.com',
    'sam\u0000@example.com',
    'sam\u0007@example.com',
    `${'a'.repeat(65)}@example.com`,
    `a@${'b'.repeat(250)}.com`,
  ])('refuses %j', (email) => {
    expect(normalizeEmail(email)).toBeNull();
  });

  it('refuses what is not text', () => {
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(12)).toBeNull();
    expect(normalizeEmail({ toString: () => EMAIL })).toBeNull();
  });

  it('accepts the longest legal address, 254 characters', () => {
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    expect(email).toHaveLength(254);
    expect(normalizeEmail(email)).toBe(email);
    expect(normalizeEmail(`x${email}`)).toBeNull();
  });
});

describe('requestCode', () => {
  it('mails a 6-digit code to the address', async () => {
    await auth.requestCode('Sam@Example.com');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.email).toBe(EMAIL);
    expect(mailer.sent[0]?.code).toMatch(/^\d{6}$/);
  });

  it('keeps the leading zeros', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 400; i++) {
      db.prepare('DELETE FROM login_codes').run();
      codes.add(await codeFor());
    }
    expect([...codes].every((code) => code.length === 6)).toBe(true);
    expect([...codes].some((code) => code.startsWith('0'))).toBe(true);
  });

  it('stores an HMAC of the address and the code, never the code', async () => {
    const code = await codeFor();
    const row = db.prepare('SELECT * FROM login_codes').get() as {
      code_hash: string;
      expires_at: number;
    };
    expect(row.code_hash).toBe(
      createHmac('sha256', SECRET).update(`${EMAIL}\n${code}`).digest('hex'),
    );
    expect(JSON.stringify(db.prepare('SELECT * FROM login_codes').all())).not.toContain(code);
    expect(row.expires_at).toBe(clock.ms() + 10 * 60 * 1000);
  });

  it('a different secret does not accept the code', async () => {
    const code = await codeFor();
    const other = createAuth({ db, mailer, secret: 'another-secret', now: clock.now });
    expect(other.verifyCode(EMAIL, code)).toBeNull();
  });

  it('sends nothing, and does not throw, for something that is not an address', async () => {
    await expect(auth.requestCode('not an address')).resolves.toBeUndefined();
    expect(mailer.sent).toEqual([]);
    expect(count('login_codes')).toBe(0);
  });

  it('creates no account', async () => {
    await codeFor();
    expect(count('accounts')).toBe(0);
  });

  it('sends 3 codes in 15 minutes and ignores the rest, quietly', async () => {
    for (let i = 0; i < CODE_SENDS_PER_WINDOW; i++) await auth.requestCode(EMAIL);
    expect(mailer.sent).toHaveLength(3);

    await expect(auth.requestCode(EMAIL)).resolves.toBeUndefined();
    await expect(auth.requestCode(EMAIL)).resolves.toBeUndefined();
    expect(mailer.sent).toHaveLength(3);
  });

  it('keeps the third code valid when the fourth request is ignored', async () => {
    await auth.requestCode(EMAIL);
    await auth.requestCode(EMAIL);
    await auth.requestCode(EMAIL);
    await auth.requestCode(EMAIL);
    expect(auth.verifyCode(EMAIL, mailer.sent[2]!.code)).not.toBeNull();
  });

  it('throttles each address on its own', async () => {
    for (let i = 0; i < 4; i++) await auth.requestCode(EMAIL);
    await auth.requestCode('other@example.com');
    expect(mailer.sent).toHaveLength(4);
  });

  it('sends again once the 15 minutes are over', async () => {
    for (let i = 0; i < 4; i++) await auth.requestCode(EMAIL);
    clock.advance(CODE_WINDOW_MS - 1);
    await auth.requestCode(EMAIL);
    expect(mailer.sent).toHaveLength(3);
    clock.advance(1);
    await auth.requestCode(EMAIL);
    expect(mailer.sent).toHaveLength(4);
  });

  it('is not reset by asking after the code expired (the row stays)', async () => {
    for (let i = 0; i < 3; i++) await auth.requestCode(EMAIL);
    clock.advance(CODE_TTL_MS + 1000); // expired, but inside the throttle window
    expect(auth.verifyCode(EMAIL, mailer.sent[2]!.code)).toBeNull();
    await auth.requestCode(EMAIL);
    expect(mailer.sent).toHaveLength(3);
  });

  it('replaces the previous code: only the newest works', async () => {
    const first = await codeFor();
    const second = await codeFor();
    if (first !== second) expect(auth.verifyCode(EMAIL, first)).toBeNull();
    expect(auth.verifyCode(EMAIL, second)).not.toBeNull();
  });

  it('rejects when the mail cannot be sent, so the route can say so', async () => {
    mailer.failWith = new Error('smtp down');
    await expect(auth.requestCode(EMAIL)).rejects.toThrow('smtp down');
  });
});

describe('verifyCode', () => {
  it('creates the account with its 15 trial analyses and signs in', async () => {
    const session = auth.verifyCode(EMAIL, await codeFor());
    expect(session?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session?.account).toMatchObject({ email: EMAIL, trial_left: 15, plan: null });
    expect(count('accounts')).toBe(1);
  });

  it('finds the same account at the next sign-in, whatever the case of the address', async () => {
    const first = auth.verifyCode(EMAIL, await codeFor());
    const second = auth.verifyCode('SAM@example.com', await codeFor('SAM@example.com'));
    expect(second?.account.id).toBe(first?.account.id);
    expect(count('accounts')).toBe(1);
  });

  it('does not reset the trial of an existing account', async () => {
    const first = auth.verifyCode(EMAIL, await codeFor());
    db.prepare('UPDATE accounts SET trial_left = 4').run();
    clock.advance(CODE_WINDOW_MS);
    const second = auth.verifyCode(EMAIL, await codeFor());
    expect(second?.account.id).toBe(first?.account.id);
    expect(second?.account.trial_left).toBe(4);
  });

  it('uses a code once', async () => {
    const code = await codeFor();
    expect(auth.verifyCode(EMAIL, code)).not.toBeNull();
    expect(auth.verifyCode(EMAIL, code)).toBeNull();
    expect(count('login_codes')).toBe(0);
    expect(count('sessions')).toBe(1);
  });

  it('refuses a wrong code and creates nothing', async () => {
    const code = await codeFor();
    expect(auth.verifyCode(EMAIL, wrongCode(code))).toBeNull();
    expect(count('accounts')).toBe(0);
    expect(count('sessions')).toBe(0);
  });

  it('refuses an address that never asked for a code', () => {
    expect(auth.verifyCode(EMAIL, '123456')).toBeNull();
    expect(auth.verifyCode('nonsense', '123456')).toBeNull();
  });

  it('refuses the code of one address for another', async () => {
    const code = await codeFor();
    expect(auth.verifyCode('other@example.com', code)).toBeNull();
    expect(auth.verifyCode(EMAIL, code)).not.toBeNull();
  });

  it('refuses what is not 6 digits', async () => {
    await codeFor();
    for (const code of ['', 'abcdef', '12345', '1234567', ' 123456']) {
      expect(auth.verifyCode(EMAIL, code)).toBeNull();
    }
  });

  it('accepts the code up to 10 minutes after it was sent, not after', async () => {
    const code = await codeFor();
    clock.advance(CODE_TTL_MS - 1);
    expect(auth.verifyCode(EMAIL, code)).not.toBeNull();

    const late = await codeFor('late@example.com');
    clock.advance(CODE_TTL_MS);
    expect(auth.verifyCode('late@example.com', late)).toBeNull();
  });

  it('locks a code after 5 wrong guesses, even for the right code', async () => {
    const code = await codeFor();
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) {
      expect(auth.verifyCode(EMAIL, wrongCode(code))).toBeNull();
    }
    expect(auth.verifyCode(EMAIL, code)).toBeNull();
    expect(count('sessions')).toBe(0);
  });

  it('lets the 5th guess be the right one', async () => {
    const code = await codeFor();
    for (let i = 0; i < CODE_MAX_ATTEMPTS - 1; i++) auth.verifyCode(EMAIL, wrongCode(code));
    expect(auth.verifyCode(EMAIL, code)).not.toBeNull();
  });

  it('gives a new code a fresh set of attempts', async () => {
    const first = await codeFor();
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) auth.verifyCode(EMAIL, wrongCode(first));
    const second = await codeFor();
    expect(auth.verifyCode(EMAIL, second)).not.toBeNull();
  });

  it('keeps the count of wrong guesses in the database', async () => {
    const code = await codeFor();
    auth.verifyCode(EMAIL, wrongCode(code));
    auth.verifyCode(EMAIL, wrongCode(code));
    const row = db.prepare('SELECT attempts FROM login_codes').get() as { attempts: number };
    expect(row.attempts).toBe(2);
  });
});

describe('the cap on wrong guesses per address', () => {
  /** `n` wrong guesses, on as many fresh codes as the throttle allows (5 guesses per code). */
  async function guessWrong(n: number, email = EMAIL): Promise<string> {
    let code = await codeFor(email);
    for (let i = 1; i <= n; i++) {
      auth.verifyCode(email, wrongCode(code));
      if (i % CODE_MAX_ATTEMPTS === 0 && i < n) code = await codeFor(email);
    }
    return code;
  }

  it('is not reset by a new code: 10 wrong guesses lock the address, whatever the codes', async () => {
    expect(LOGIN_FAILURES_PER_WINDOW).toBe(10);
    await guessWrong(LOGIN_FAILURES_PER_WINDOW);
    expect(count('login_failures')).toBe(10);

    // A third, fresh code has all its 5 attempts, and the right code is still refused.
    const fresh = await codeFor();
    expect(auth.verifyCode(EMAIL, fresh)).toBeNull();
    expect(count('sessions')).toBe(0);
    expect(count('accounts')).toBe(0);
  });

  it('stays quiet about it: the right code and a wrong one both answer null, nothing more is counted', async () => {
    await guessWrong(LOGIN_FAILURES_PER_WINDOW);
    const fresh = await codeFor();

    expect(auth.verifyCode(EMAIL, wrongCode(fresh))).toBeNull();
    expect(auth.verifyCode(EMAIL, fresh)).toBeNull();
    expect(count('login_failures')).toBe(10);
    // The locked attempts did not even spend the code's own attempts.
    const row = db.prepare('SELECT attempts FROM login_codes').get() as { attempts: number };
    expect(row.attempts).toBe(0);
  });

  it('lets the 10th guess be the right one', async () => {
    const code = await guessWrong(LOGIN_FAILURES_PER_WINDOW - 1);
    expect(auth.verifyCode(EMAIL, code)).not.toBeNull();
  });

  it('is rolling: the lock ends when the oldest guesses leave the day, not at a fixed hour', async () => {
    await guessWrong(LOGIN_FAILURES_PER_WINDOW);

    clock.advance(LOGIN_FAILURE_WINDOW_MS - 1);
    expect(auth.verifyCode(EMAIL, await codeFor())).toBeNull();

    clock.advance(1);
    expect(auth.verifyCode(EMAIL, await codeFor())).not.toBeNull();
  });

  it('counts guesses spread over the day: the 11th inside 24 hours is locked, one that aged out frees a place', async () => {
    for (let hour = 0; hour < LOGIN_FAILURES_PER_WINDOW; hour++) {
      const code = await codeFor();
      auth.verifyCode(EMAIL, wrongCode(code));
      clock.advance(60 * 60 * 1000);
    }
    // 10 hours in, 10 guesses in the last 24 hours.
    expect(auth.verifyCode(EMAIL, await codeFor())).toBeNull();

    // The first guess is now 24 hours old: it is out, 9 remain, the right code opens a session.
    clock.advance(14 * 60 * 60 * 1000);
    expect(auth.verifyCode(EMAIL, await codeFor())).not.toBeNull();
  });

  it('does not count what was no guess: no code asked, an expired code, a locked code', async () => {
    for (let i = 0; i < 20; i++) auth.verifyCode(EMAIL, '123456');
    expect(count('login_failures')).toBe(0);

    const expired = await codeFor();
    clock.advance(CODE_TTL_MS);
    expect(auth.verifyCode(EMAIL, wrongCode(expired))).toBeNull();
    expect(count('login_failures')).toBe(0);
  });

  it('counts each address on its own, and the right code of another address still works', async () => {
    await guessWrong(LOGIN_FAILURES_PER_WINDOW);
    expect(auth.verifyCode('other@example.com', await codeFor('other@example.com'))).not.toBeNull();
  });

  it('is dropped by the maintenance once a day old, not before', async () => {
    await guessWrong(3);
    clock.advance(LOGIN_FAILURE_WINDOW_MS - 1);
    purgeExpired(db, clock.ms());
    expect(count('login_failures')).toBe(3);
    clock.advance(1);
    purgeExpired(db, clock.ms());
    expect(count('login_failures')).toBe(0);
  });
});

describe('the free trial of a new account', () => {
  const trialOf = (email: string) =>
    (
      db.prepare('SELECT trial_left FROM accounts WHERE email = ?').get(email) as {
        trial_left: number;
      }
    ).trial_left;

  async function verify(email: string, ip: string | null = null) {
    return auth.verifyCode(email, await codeFor(email), ip);
  }

  it.each([
    ['sam+promo@example.com', 'a +tag'],
    ['Sam+a+b@Example.com', 'several tags'],
  ])('is not given again to %s, an alias of an address that has an account (%s)', async (alias) => {
    await verify(EMAIL);

    const session = await verify(alias);

    expect(session?.account).toMatchObject({ trial_left: 0, canonical_email: EMAIL });
    expect(count('accounts')).toBe(2);
  });

  it('knows the Gmail variants: dots, +tag and googlemail.com are one mailbox', async () => {
    await verify('j.doe@gmail.com');
    for (const alias of ['jdoe@gmail.com', 'j.d.o.e+x@gmail.com', 'jdoe@googlemail.com']) {
      expect((await verify(alias))?.account.trial_left).toBe(0);
    }
  });

  it('does not take the dots of another provider for noise, nor an unrelated address for an alias', async () => {
    await verify('a.b@example.com');
    expect((await verify('ab@example.com'))?.account.trial_left).toBe(15);
    expect((await verify('a.b@gmail.com'))?.account.trial_left).toBe(15);
  });

  it('signs in with the exact address typed: the alias has its own account, and keeps it', async () => {
    const first = await verify(EMAIL);
    const alias = await verify('sam+promo@example.com');
    expect(alias?.account.id).not.toBe(first?.account.id);

    const again = await verify('sam+promo@example.com');
    expect(again?.account.id).toBe(alias?.account.id);
    expect(count('accounts')).toBe(2);
    // The first account is untouched.
    expect(trialOf(EMAIL)).toBe(15);
  });

  it('gives the trial to the first account of a mailbox, whichever alias comes first', async () => {
    expect((await verify('sam+first@example.com'))?.account.trial_left).toBe(15);
    expect((await verify(EMAIL))?.account.trial_left).toBe(0);
  });

  it('creates at most 3 accounts with a trial per client address and day', async () => {
    expect(SIGNUPS_PER_IP_PER_WINDOW).toBe(3);
    for (let i = 1; i <= SIGNUPS_PER_IP_PER_WINDOW; i++) {
      expect((await verify(`u${i}@example.com`, '203.0.113.7'))?.account.trial_left).toBe(15);
    }

    const fourth = await verify('u4@example.com', '203.0.113.7');
    // The code was sent and the sign-in works: only the trial is gone.
    expect(fourth?.token).toBeTruthy();
    expect(fourth?.account).toMatchObject({ email: 'u4@example.com', trial_left: 0 });
  });

  it('lets an existing account sign in from a busy address, trial untouched', async () => {
    await verify('known@example.com', '198.51.100.1');
    for (let i = 1; i <= 4; i++) await verify(`u${i}@example.com`, '198.51.100.1');

    const back = await verify('known@example.com', '198.51.100.1');

    expect(back?.account.trial_left).toBe(15);
    expect(count('accounts')).toBe(5);
  });

  it('counts each address on its own, and starts again after a day', async () => {
    for (let i = 1; i <= 4; i++) await verify(`a${i}@example.com`, '192.0.2.1');
    expect(trialOf('a4@example.com')).toBe(0);
    expect((await verify('b1@example.com', '192.0.2.2'))?.account.trial_left).toBe(15);

    clock.advance(SIGNUP_WINDOW_MS - 1);
    expect((await verify('late1@example.com', '192.0.2.1'))?.account.trial_left).toBe(0);
    clock.advance(SIGNUP_WINDOW_MS);
    expect((await verify('late2@example.com', '192.0.2.1'))?.account.trial_left).toBe(15);
  });

  it('does not cap an address nobody could tell', async () => {
    for (let i = 1; i <= 5; i++) {
      expect((await verify(`n${i}@example.com`, null))?.account.trial_left).toBe(15);
    }
    expect(count('signups')).toBe(0);
  });

  it('keeps no client address, only a keyed hash, and drops it after a day', async () => {
    await verify('keep@example.com', '203.0.113.99');

    const row = db.prepare('SELECT ip_hash FROM signups').get() as { ip_hash: string };
    expect(row.ip_hash).toBe(createHmac('sha256', SECRET).update('ip\n203.0.113.99').digest('hex'));
    expect(JSON.stringify(db.prepare('SELECT * FROM signups').all())).not.toContain('203.0.113.99');

    clock.advance(SIGNUP_WINDOW_MS);
    purgeExpired(db, clock.ms());
    expect(count('signups')).toBe(0);
  });
});

describe('sessions', () => {
  it('stores the SHA-256 of the token, never the token', async () => {
    const token = await signIn();
    const rows = db.prepare('SELECT * FROM sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(db.prepare('SELECT * FROM accounts').all())).not.toContain(token);
  });

  it('gives each sign-in its own token', async () => {
    const first = await signIn();
    clock.advance(CODE_WINDOW_MS);
    const second = await signIn();
    expect(first).not.toBe(second);
    expect(auth.authenticate(first)).not.toBeNull();
    expect(auth.authenticate(second)).not.toBeNull();
  });

  it('keeps 3 sessions per account and signs the oldest out', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS + 1; i++) {
      tokens.push(await signIn());
      clock.advance(CODE_WINDOW_MS);
    }
    expect(count('sessions')).toBe(3);
    expect(auth.authenticate(tokens[0]!)).toBeNull();
    for (const token of tokens.slice(1)) expect(auth.authenticate(token)).not.toBeNull();
  });

  it('breaks a tie between sessions made in the same millisecond by order', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 4; i++) {
      tokens.push(await signIn());
    }
    expect(auth.authenticate(tokens[0]!)).toBeNull();
    expect(auth.authenticate(tokens[3]!)).not.toBeNull();
    expect(count('sessions')).toBe(3);
  });

  it("does not touch another account's sessions", async () => {
    const other = await signIn('other@example.com');
    for (let i = 0; i < 5; i++) {
      await signIn();
    }
    expect(auth.authenticate(other)).not.toBeNull();
  });

  it('removes the sessions with the account', async () => {
    await signIn();
    db.prepare('DELETE FROM accounts').run();
    expect(count('sessions')).toBe(0);
  });
});

describe('authenticate', () => {
  it('finds the account of a token', async () => {
    const token = await signIn();
    expect(auth.authenticate(token)).toMatchObject({ email: EMAIL, trial_left: 15 });
  });

  it('answers null for an unknown, empty or malformed token', async () => {
    await signIn();
    expect(auth.authenticate('A'.repeat(43))).toBeNull();
    expect(auth.authenticate('')).toBeNull();
    expect(auth.authenticate("x' OR '1'='1")).toBeNull();
    expect(auth.authenticate('a'.repeat(5000))).toBeNull();
  });

  it('does not accept the stored hash as a token', async () => {
    await signIn();
    const row = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(auth.authenticate(row.token_hash)).toBeNull();
  });

  it('writes last_used_at at most once a minute', async () => {
    const token = await signIn();
    const lastUsed = () =>
      (db.prepare('SELECT last_used_at FROM sessions').get() as { last_used_at: number })
        .last_used_at;
    const created = clock.ms();

    clock.advance(59_000);
    auth.authenticate(token);
    expect(lastUsed()).toBe(created);

    clock.advance(1000);
    auth.authenticate(token);
    expect(lastUsed()).toBe(clock.ms());
  });

  it('stops working after 90 idle days, and forgets the session', async () => {
    const token = await signIn();
    clock.advance(SESSION_IDLE_MS - 1);
    expect(auth.authenticate(token)).not.toBeNull(); // using it renews it
    clock.advance(SESSION_IDLE_MS);
    expect(auth.authenticate(token)).toBeNull();
    expect(count('sessions')).toBe(0);
  });

  it('returns the current state of the account, plan included', async () => {
    const token = await signIn();
    db.prepare("UPDATE accounts SET plan = 'revendeur', subscription_status = 'active'").run();
    expect(auth.authenticate(token)).toMatchObject({ plan: 'revendeur' });
  });
});

describe('logout', () => {
  it('ends the session of that token only', async () => {
    const first = await signIn();
    clock.advance(CODE_WINDOW_MS);
    const second = await signIn();
    auth.logout(first);
    expect(auth.authenticate(first)).toBeNull();
    expect(auth.authenticate(second)).not.toBeNull();
  });

  it('is fine to repeat or to do with a token that is not one', async () => {
    const token = await signIn();
    auth.logout(token);
    expect(() => auth.logout(token)).not.toThrow();
    expect(() => auth.logout('')).not.toThrow();
  });
});

describe('purgeExpired', () => {
  it('drops finished codes and idle sessions, keeps the rest', async () => {
    await auth.requestCode('old@example.com');
    const idle = await signIn('idle@example.com');
    clock.advance(SESSION_IDLE_MS / 2);
    await auth.requestCode('fresh@example.com');
    const active = await signIn('active@example.com');
    clock.advance(SESSION_IDLE_MS / 2 + 1);
    db.prepare("INSERT INTO cache (key, value, expires_at) VALUES ('old', '1', ?)").run(
      clock.ms() - 1,
    );
    db.prepare("INSERT INTO cache (key, value, expires_at) VALUES ('live', '1', ?)").run(
      clock.ms() + 1000,
    );

    purgeExpired(db, clock.ms());

    expect(auth.authenticate(idle)).toBeNull();
    expect(auth.authenticate(active)).not.toBeNull();
    expect(db.prepare('SELECT key FROM cache').all()).toEqual([{ key: 'live' }]);
    expect(count('login_codes')).toBe(0);
  });

  it('keeps the send counter of a code that expired inside its throttle window', async () => {
    await auth.requestCode(EMAIL);
    clock.advance(CODE_TTL_MS + 1000);
    purgeExpired(db, clock.ms());
    expect(count('login_codes')).toBe(1);
    clock.advance(CODE_WINDOW_MS);
    purgeExpired(db, clock.ms());
    expect(count('login_codes')).toBe(0);
  });
});
