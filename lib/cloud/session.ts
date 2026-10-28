import { browser } from 'wxt/browser';
import { isRecord } from '../json';
import { withLock } from '../lock';
import { parseStatus, type CloudStatus } from './types';

/**
 * `storage.local` key of the session: `{ token, email }`, or `{ expired: true, email }` once the
 * server has refused the token (a 401): the marker keeps the address, so the options page can
 * offer the sign-in again, and holds no token. The token is a secret like an API key: only the
 * background reads it and sends it (in the `Authorization` header, to the Fripon server), and
 * nothing hands it to a page: the messages carry no token, and the options page follows
 * `STATUS_KEY` for the account and reads this key only through `loadExpired` (the address of the
 * marker). `storage.local` itself is readable by every context of the extension, content scripts
 * included, so this holds by what the code does, not by an access rule of the storage.
 */
export const SESSION_KEY = 'fripon:cloud:v1';
/**
 * `storage.local` key of the account status (see `CloudStatus`), the token left out. It exists
 * exactly as long as the session does, so the options page can follow it (`useStored`).
 */
export const STATUS_KEY = 'fripon:cloud:status:v1';
/** Name of the lock that serialises every write of the two keys above. */
export const SESSION_LOCK = 'fripon:cloud';

export interface CloudSession {
  token: string;
  email: string;
}

/** What a session leaves once the server has refused it: the address, never a token. */
export interface ExpiredSession {
  email: string;
}

/** signed_in: a token is stored. expired: only the marker is. signed_out: nothing usable. */
export type SessionState = 'signed_in' | 'expired' | 'signed_out';

/** null for anything this version did not write. */
function parseSession(raw: unknown): CloudSession | null {
  if (!isRecord(raw)) return null;
  const { token, email } = raw;
  if (typeof token !== 'string' || token === '' || typeof email !== 'string') return null;
  return { token, email };
}

/** null for anything that is not the marker of an expired session. */
function parseExpired(raw: unknown): ExpiredSession | null {
  if (!isRecord(raw) || raw.expired !== true || typeof raw.email !== 'string') return null;
  return { email: raw.email };
}

const readSession = async (): Promise<unknown> =>
  (await browser.storage.local.get(SESSION_KEY))[SESSION_KEY];

/** The stored session, null when signed out (or expired: there is no token then). */
export async function loadSession(): Promise<CloudSession | null> {
  return parseSession(await readSession());
}

/** The marker of an expired session, null when there is none (signed in, or signed out). */
export async function loadExpired(): Promise<ExpiredSession | null> {
  return parseExpired(await readSession());
}

/** Where the session stands, from one read. */
export async function sessionState(): Promise<SessionState> {
  const raw = await readSession();
  if (parseSession(raw)) return 'signed_in';
  return parseExpired(raw) ? 'expired' : 'signed_out';
}

/** The stored status, null when there is none (signed out, or not written yet). */
export async function loadStatus(): Promise<CloudStatus | null> {
  return parseStatus((await browser.storage.local.get(STATUS_KEY))[STATUS_KEY]);
}

/** Signs in: the session and a first status (nothing is known of the usage yet) go in together. */
export function saveSession(session: CloudSession): Promise<void> {
  return withLock(SESSION_LOCK, () =>
    browser.storage.local.set({
      [SESSION_KEY]: session,
      [STATUS_KEY]: { email: session.email, usage: null, subscription: null, checkedAt: 0 },
    }),
  );
}

/** Signs out, the marker of an expired session included. */
export function clearSession(): Promise<void> {
  return withLock(SESSION_LOCK, () => browser.storage.local.remove([SESSION_KEY, STATUS_KEY]));
}

/**
 * The server refused `token` (a 401): the token and the status go, a marker with the address
 * stays. Only while that token is still the stored one: a request that was answered 401 must not
 * end a session that replaced its own in the meantime.
 */
export function expireSession(token: string): Promise<void> {
  return withLock(SESSION_LOCK, async () => {
    const session = await loadSession();
    if (session?.token !== token) return;
    // The status first: a marker with a status left behind would show a signed-in account.
    await browser.storage.local.remove(STATUS_KEY);
    await browser.storage.local.set({ [SESSION_KEY]: { expired: true, email: session.email } });
  });
}

/** Forgets the marker of an expired session, and never touches a live session. */
export function clearExpired(): Promise<void> {
  return withLock(SESSION_LOCK, async () => {
    if (await loadExpired()) await browser.storage.local.remove(SESSION_KEY);
  });
}

/**
 * Stores the status read for the session of `token`, unless that session is gone since (a sign-out
 * while the server was answering must not leave a status behind, and the options page would show
 * a signed-in account).
 */
export function saveStatusFor(token: string, status: CloudStatus): Promise<void> {
  return withLock(SESSION_LOCK, async () => {
    if ((await loadSession())?.token !== token) return;
    await browser.storage.local.set({ [STATUS_KEY]: status });
  });
}
