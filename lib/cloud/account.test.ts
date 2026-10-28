import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createCloudAccount } from './account';
import type { CloudClient } from './client';
import {
  expireSession,
  loadExpired,
  loadSession,
  loadStatus,
  saveSession,
  SESSION_KEY,
  STATUS_KEY,
} from './session';
import { createStatusKeeper } from './status';
import { PLAN_USAGE, makeClient } from './test-helpers';

function setup(client: CloudClient = makeClient(), openTab = vi.fn(() => Promise.resolve())) {
  const status = createStatusKeeper({ client });
  const account = createCloudAccount({ client, status, openTab });
  return { account, client, openTab };
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('signing in', () => {
  it('asks for a code with the address trimmed and in lower case', async () => {
    const { account, client } = setup();
    expect(await account.requestCode('  Moi@Exemple.FR ')).toEqual({ ok: true });
    expect(client.requestCode).toHaveBeenCalledWith('moi@exemple.fr');
  });

  it('passes on the words of a refused code request', async () => {
    const { account } = setup(
      makeClient({
        requestCode: vi.fn(() =>
          Promise.resolve({ ok: false as const, reason: 'rate_limited' as const }),
        ),
      }),
    );
    expect(await account.requestCode('a@b.fr')).toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('stores the session and reads the account on a right code, and returns no token', async () => {
    const { account, client } = setup();
    const result = await account.verify('A@B.fr', '123456');
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain('tok-1');
    expect(client.verify).toHaveBeenCalledWith('a@b.fr', '123456');
    expect(await loadSession()).toEqual({ token: 'tok-1', email: 'a@b.fr' });
    expect(await loadStatus()).toMatchObject({ email: 'a@b.fr', usage: PLAN_USAGE });
  });

  it('is signed in even when the first reading of the account fails', async () => {
    const { account } = setup(
      makeClient({
        me: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'network' as const })),
      }),
    );
    expect(await account.verify('a@b.fr', '123456')).toEqual({ ok: true });
    expect(await loadStatus()).toEqual({
      email: 'a@b.fr',
      usage: null,
      subscription: null,
      checkedAt: 0,
    });
  });

  it('ends the session it replaces at the server, then stores the new one', async () => {
    await saveSession({ token: 'old-token', email: 'old@b.fr' });
    const { account, client } = setup();
    expect(await account.verify('a@b.fr', '123456')).toEqual({ ok: true });
    expect(client.logout).toHaveBeenCalledTimes(1);
    expect(client.logout).toHaveBeenCalledWith('old-token');
    expect(await loadSession()).toEqual({ token: 'tok-1', email: 'a@b.fr' });
  });

  it('is signed in even when ending the old session fails or never answers', async () => {
    await saveSession({ token: 'old-token', email: 'old@b.fr' });
    for (const logout of [
      vi.fn(() => Promise.reject(new Error('offline'))),
      vi.fn(() => new Promise<void>(() => undefined)),
    ]) {
      const { account } = setup(makeClient({ logout }));
      expect(await account.verify('a@b.fr', '123456')).toEqual({ ok: true });
      expect(await loadSession()).toEqual({ token: 'tok-1', email: 'a@b.fr' });
      await saveSession({ token: 'old-token', email: 'old@b.fr' });
    }
  });

  it('ends nothing without a previous session, for a wrong code, or for the same token', async () => {
    const first = setup();
    await first.account.verify('a@b.fr', '123456');
    expect(first.client.logout).not.toHaveBeenCalled();

    await saveSession({ token: 'old-token', email: 'old@b.fr' });
    const wrong = setup(
      makeClient({
        verify: vi.fn(() =>
          Promise.resolve({ ok: false as const, reason: 'invalid_code' as const }),
        ),
      }),
    );
    await wrong.account.verify('a@b.fr', '000000');
    expect(wrong.client.logout).not.toHaveBeenCalled();
    expect(await loadSession()).toEqual({ token: 'old-token', email: 'old@b.fr' });

    // A server that answers with the token already held must not revoke the session it just gave.
    const same = setup(
      makeClient({
        verify: vi.fn(() => Promise.resolve({ ok: true as const, token: 'old-token' })),
      }),
    );
    await same.account.verify('a@b.fr', '123456');
    expect(same.client.logout).not.toHaveBeenCalled();
  });

  it('stores nothing for a wrong code', async () => {
    const { account } = setup(
      makeClient({
        verify: vi.fn(() =>
          Promise.resolve({ ok: false as const, reason: 'invalid_code' as const }),
        ),
      }),
    );
    expect(await account.verify('a@b.fr', '000000')).toEqual({ ok: false, reason: 'invalid_code' });
    expect(await loadSession()).toBeNull();
    expect(await loadStatus()).toBeNull();
  });
});

describe('the status', () => {
  it('is null when signed out and the usage once signed in, read from the server each time', async () => {
    const { account, client } = setup();
    expect(await account.status()).toBeNull();
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    expect((await account.status())?.usage).toEqual(PLAN_USAGE);
    await account.status();
    expect(client.me).toHaveBeenCalledTimes(2);
  });
});

describe('signing out', () => {
  it('forgets the session here first, then tells the server', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    const logout = vi.fn(async () => {
      // By the time the server is told, nothing is left in the browser.
      expect(await loadSession()).toBeNull();
    });
    const { account } = setup(makeClient({ logout }));
    await account.signOut();
    expect(logout).toHaveBeenCalledWith('tok-1');
    const stored = await fakeBrowser.storage.local.get([SESSION_KEY, STATUS_KEY]);
    expect(stored).toEqual({});
  });

  it('is signed out even when the server cannot be told', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    const { account } = setup(makeClient({ logout: vi.fn(() => Promise.resolve()) }));
    await account.signOut();
    expect(await loadSession()).toBeNull();
  });

  it('does nothing when already signed out', async () => {
    const { account, client } = setup();
    await account.signOut();
    expect(client.logout).not.toHaveBeenCalled();
  });

  it('forgets an expired session too, without telling the server (it has no token)', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    await expireSession('tok-1');
    const { account, client } = setup();
    await account.signOut();
    expect(await loadExpired()).toBeNull();
    expect(client.logout).not.toHaveBeenCalled();
  });
});

describe('signing in again after the session expired', () => {
  it('replaces the marker with the new session', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    await expireSession('tok-1');
    expect(await loadExpired()).toEqual({ email: 'a@b.fr' });
    const { account, client } = setup();
    expect(await account.verify('a@b.fr', '123456')).toEqual({ ok: true });
    expect(await loadExpired()).toBeNull();
    expect((await loadSession())?.token).toBe('tok-1');
    // There was no token to end at the server.
    expect(client.logout).not.toHaveBeenCalled();
  });
});

describe('deleting the account', () => {
  it('clears the session here once the server has deleted the account', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    const { account, client } = setup();
    expect(await account.deleteAccount()).toEqual({ ok: true });
    expect(client.deleteAccount).toHaveBeenCalledOnce();
    expect(await fakeBrowser.storage.local.get([SESSION_KEY, STATUS_KEY])).toEqual({});
  });

  it('keeps the session when the server refuses (an active subscription), and says why', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    const { account } = setup(
      makeClient({
        deleteAccount: vi.fn(() =>
          Promise.resolve({ ok: false as const, reason: 'active_subscription' as const }),
        ),
      }),
    );
    expect(await account.deleteAccount()).toEqual({ ok: false, reason: 'active_subscription' });
    expect((await loadSession())?.token).toBe('tok-1');
    expect(await loadStatus()).not.toBeNull();
  });

  it('keeps the session when the server cannot be reached', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    const { account } = setup(
      makeClient({
        deleteAccount: vi.fn(() =>
          Promise.resolve({ ok: false as const, reason: 'network' as const }),
        ),
      }),
    );
    expect(await account.deleteAccount()).toEqual({ ok: false, reason: 'network' });
    expect((await loadSession())?.token).toBe('tok-1');
  });
});

describe('billing', () => {
  it('opens the Checkout page of the chosen price in a new tab', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    const { account, client, openTab } = setup();
    expect(await account.checkout('revendeur_monthly')).toEqual({ ok: true });
    expect(client.checkout).toHaveBeenCalledWith('revendeur_monthly');
    expect(openTab).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/x');
  });

  it('opens the customer portal in a new tab', async () => {
    const { account, openTab } = setup();
    expect(await account.portal()).toEqual({ ok: true });
    expect(openTab).toHaveBeenCalledWith('https://billing.stripe.com/p/session/x');
  });

  it('opens nothing when the server refuses', async () => {
    const { account, openTab } = setup(
      makeClient({
        portal: vi.fn(() =>
          Promise.resolve({ ok: false as const, reason: 'no_customer' as const }),
        ),
      }),
    );
    expect(await account.portal()).toEqual({ ok: false, reason: 'no_customer' });
    expect(openTab).not.toHaveBeenCalled();
  });

  it('says so when the tab cannot be opened', async () => {
    const { account } = setup(
      makeClient(),
      vi.fn(() => Promise.reject(new Error('no tabs'))),
    );
    expect(await account.checkout('essentiel_monthly')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});
