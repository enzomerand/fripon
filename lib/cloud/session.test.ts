import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  SESSION_KEY,
  STATUS_KEY,
  clearExpired,
  clearSession,
  expireSession,
  loadExpired,
  loadSession,
  loadStatus,
  saveSession,
  saveStatusFor,
  sessionState,
} from './session';
import type { CloudStatus } from './types';

const STATUS: CloudStatus = {
  email: 'a@b.fr',
  usage: {
    kind: 'trial',
    month: { used: 1, cap: null },
    day: { used: 1, cap: null },
    trialLeft: 14,
  },
  subscription: null,
  checkedAt: 1000,
};

beforeEach(() => {
  fakeBrowser.reset();
});

describe('session storage', () => {
  it('is signed out by default', async () => {
    expect(await loadSession()).toBeNull();
    expect(await loadStatus()).toBeNull();
  });

  it('stores the token and a first status, without the token in the status', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    expect(await loadSession()).toEqual({ token: 'tok-1', email: 'a@b.fr' });
    const status = await loadStatus();
    expect(status).toEqual({ email: 'a@b.fr', usage: null, subscription: null, checkedAt: 0 });
    const raw = (await browser.storage.local.get(STATUS_KEY))[STATUS_KEY];
    expect(JSON.stringify(raw)).not.toContain('tok-1');
  });

  it('keeps the token under its own key and the status under another', () => {
    expect(SESSION_KEY).toBe('fripon:cloud:v1');
    expect(STATUS_KEY).toBe('fripon:cloud:status:v1');
  });

  it('reads a damaged session as signed out', async () => {
    await browser.storage.local.set({ [SESSION_KEY]: { token: '', email: 'a@b.fr' } });
    expect(await loadSession()).toBeNull();
    await browser.storage.local.set({ [SESSION_KEY]: 'nope' });
    expect(await loadSession()).toBeNull();
  });

  it('signs out by removing both keys', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    await clearSession();
    expect(await loadSession()).toBeNull();
    expect(await loadStatus()).toBeNull();
  });

  it('writes a status only for the session it was read for', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    await saveStatusFor('tok-1', STATUS);
    expect(await loadStatus()).toEqual(STATUS);

    // Signed out while the server was answering: nothing is left behind.
    await clearSession();
    await saveStatusFor('tok-1', { ...STATUS, checkedAt: 2000 });
    expect(await loadStatus()).toBeNull();

    // Another session took over: the older answer is dropped.
    await saveSession({ token: 'tok-2', email: 'a@b.fr' });
    await saveStatusFor('tok-1', STATUS);
    expect((await loadStatus())?.checkedAt).toBe(0);
  });
});

describe('an expired session', () => {
  it('keeps the address and no token, and drops the status', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    await saveStatusFor('tok-1', STATUS);
    expect(await sessionState()).toBe('signed_in');

    await expireSession('tok-1');
    expect(await sessionState()).toBe('expired');
    expect(await loadSession()).toBeNull();
    expect(await loadStatus()).toBeNull();
    expect(await loadExpired()).toEqual({ email: 'a@b.fr' });
    const raw = (await browser.storage.local.get(SESSION_KEY))[SESSION_KEY];
    expect(raw).toEqual({ expired: true, email: 'a@b.fr' });
    expect(JSON.stringify(raw)).not.toContain('tok-1');
  });

  it('only ends the session whose token it is, never a newer one', async () => {
    await saveSession({ token: 'new', email: 'a@b.fr' });
    await expireSession('old');
    expect(await sessionState()).toBe('signed_in');
    expect((await loadSession())?.token).toBe('new');
  });

  it('does nothing without a session, and twice the same as once', async () => {
    await expireSession('tok-1');
    expect(await sessionState()).toBe('signed_out');
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    await expireSession('tok-1');
    await expireSession('tok-1');
    expect(await loadExpired()).toEqual({ email: 'a@b.fr' });
  });

  it('takes no status after it, for the token that was refused', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    await expireSession('tok-1');
    await saveStatusFor('tok-1', STATUS);
    expect(await loadStatus()).toBeNull();
  });

  it('is cleared by a sign-in, a sign-out and clearExpired, and only by those', async () => {
    const expired = async () => {
      await saveSession({ token: 'tok-1', email: 'a@b.fr' });
      await expireSession('tok-1');
    };
    await expired();
    await saveSession({ token: 'tok-2', email: 'a@b.fr' });
    expect(await sessionState()).toBe('signed_in');

    await expired();
    await clearSession();
    expect(await sessionState()).toBe('signed_out');

    await expired();
    await clearExpired();
    expect(await sessionState()).toBe('signed_out');
  });

  it('clearExpired never touches a live session', async () => {
    await saveSession({ token: 'tok-1', email: 'a@b.fr' });
    await saveStatusFor('tok-1', STATUS);
    await clearExpired();
    expect(await sessionState()).toBe('signed_in');
    expect(await loadStatus()).toEqual(STATUS);
  });

  it('reads a damaged marker as signed out', async () => {
    for (const raw of [
      { expired: true },
      { expired: 'yes', email: 'a@b.fr' },
      { email: 'a@b.fr' },
    ]) {
      await browser.storage.local.set({ [SESSION_KEY]: raw });
      expect(await sessionState()).toBe('signed_out');
      expect(await loadExpired()).toBeNull();
    }
  });
});
