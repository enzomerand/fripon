import { browser } from 'wxt/browser';
import { isRecord } from '../json';
import { withLock } from '../lock';
import { parseStatus, type CloudStatus } from './types';

/**
 * `storage.local` key of the session: `{ token, email }`. The token is a secret like an API key:
 * only the background reads it and sends it (in the `Authorization` header, to the Fripon server),
 * and nothing hands it to a page: the messages carry no token, and the options page follows
 * `STATUS_KEY` only. `storage.local` itself is readable by every context of the extension, content
 * scripts included, so this holds by what the code does, not by an access rule of the storage.
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

/** null for anything this version did not write. */
function parseSession(raw: unknown): CloudSession | null {
  if (!isRecord(raw)) return null;
  const { token, email } = raw;
  if (typeof token !== 'string' || token === '' || typeof email !== 'string') return null;
  return { token, email };
}

/** The stored session, null when signed out. */
export async function loadSession(): Promise<CloudSession | null> {
  return parseSession((await browser.storage.local.get(SESSION_KEY))[SESSION_KEY]);
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

/**
 * Signs out. With `onlyToken`, only when that token is still the stored one: a request that was
 * answered 401 must not sign out a session that replaced its own in the meantime.
 */
export function clearSession(onlyToken?: string): Promise<void> {
  return withLock(SESSION_LOCK, async () => {
    if (onlyToken !== undefined && (await loadSession())?.token !== onlyToken) return;
    await browser.storage.local.remove([SESSION_KEY, STATUS_KEY]);
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
