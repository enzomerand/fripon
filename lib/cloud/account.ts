import type { CloudClient } from './client';
import { clearSession, loadSession, saveSession } from './session';
import type { StatusKeeper } from './status';
import type { CloudStatus, LinkResult, PriceKey, RequestCodeResult, VerifyResult } from './types';

/** What the options page can ask of the account (the background messages `cloud*`). */
export interface CloudAccount {
  /** Asks the server again, then answers with the snapshot; null when signed out. */
  status(): Promise<CloudStatus | null>;
  requestCode(email: string): Promise<RequestCodeResult>;
  /**
   * On success the session is stored (the token goes no further) and the status is read. A session
   * it replaces is ended at the server.
   */
  verify(email: string, code: string): Promise<VerifyResult>;
  /** Signs out here first, whatever the server says. */
  signOut(): Promise<void>;
  checkout(price: PriceKey): Promise<LinkResult>;
  portal(): Promise<LinkResult>;
}

export interface CloudAccountDeps {
  client: CloudClient;
  status: StatusKeeper;
  /** Opens a page in a new tab. */
  openTab(url: string): Promise<unknown>;
}

/** The address as the server keeps it (it lower-cases it too). */
const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function createCloudAccount(deps: CloudAccountDeps): CloudAccount {
  /** Opens the page the server gave, from the background: the options page cannot reach a tab. */
  async function open(call: ReturnType<CloudClient['checkout']>): Promise<LinkResult> {
    const result = await call;
    if (!result.ok) return result;
    try {
      await deps.openTab(result.url);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  return {
    // Every read of the status here asks the server: the user is looking at it (or has just paid).
    status: () => deps.status.current(0),

    requestCode: (email) => deps.client.requestCode(normalizeEmail(email)),

    async verify(email, code) {
      const address = normalizeEmail(email);
      const result = await deps.client.verify(address, code);
      if (!result.ok) return result;
      // Signing in over a session (another address, or the same one again) would leave the old
      // token alive at the server: end it, from here and without waiting. Best effort, the
      // sign-in never depends on it.
      const previous = await loadSession().catch(() => null);
      if (previous && previous.token !== result.token) {
        void deps.client.logout(previous.token).catch(() => undefined);
      }
      await saveSession({ token: result.token, email: address });
      // The first read fills in the plan and the usage. Not reading it is not a failed sign-in:
      // the page shows the account, and the gates ask again.
      await deps.status.current(0).catch(() => undefined);
      return { ok: true };
    },

    async signOut() {
      const session = await loadSession();
      await clearSession();
      if (session) await deps.client.logout(session.token);
    },

    checkout: (price) => open(deps.client.checkout(price)),
    portal: () => open(deps.client.portal()),
  };
}
