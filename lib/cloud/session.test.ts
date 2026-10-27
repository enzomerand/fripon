import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  SESSION_KEY,
  STATUS_KEY,
  clearSession,
  loadSession,
  loadStatus,
  saveSession,
  saveStatusFor,
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

  it('signs out for a token only while it is still the stored one', async () => {
    await saveSession({ token: 'new', email: 'a@b.fr' });
    await clearSession('old');
    expect((await loadSession())?.token).toBe('new');
    await clearSession('new');
    expect(await loadSession()).toBeNull();
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
