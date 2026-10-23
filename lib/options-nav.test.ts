import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  PENDING_SECTION_KEY,
  isPendingSection,
  openOptionsAt,
  takePendingSection,
} from './options-nav';

const stored = async () =>
  (await browser.storage.session.get(PENDING_SECTION_KEY))[PENDING_SECTION_KEY];

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('isPendingSection', () => {
  it('knows the sections the page can show', () => {
    for (const section of ['welcome', 'guide', 'keys', 'credits']) {
      expect(isPendingSection(section)).toBe(true);
    }
    for (const other of ['mode', '', 'GUIDE', 3, null, undefined, {}]) {
      expect(isPendingSection(other)).toBe(false);
    }
  });
});

describe('openOptionsAt', () => {
  it('stores the section in session storage then opens the options page', async () => {
    const open = vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined as never);
    await openOptionsAt('credits');
    expect(await stored()).toBe('credits');
    expect(open).toHaveBeenCalledOnce();
    expect(PENDING_SECTION_KEY).toBe('fripon:options:pendingSection');
  });

  it('keeps it out of local storage', async () => {
    vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined as never);
    await openOptionsAt('guide');
    expect(await browser.storage.local.get(null)).toEqual({});
  });

  it('clears an older request when none is made', async () => {
    vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined as never);
    await browser.storage.session.set({ [PENDING_SECTION_KEY]: 'guide' });
    await openOptionsAt();
    expect(await stored()).toBeUndefined();
  });

  it('still opens the page when session storage is not available', async () => {
    const open = vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined as never);
    vi.spyOn(browser.storage.session, 'set').mockRejectedValue(new Error('no session storage'));
    await expect(openOptionsAt('guide')).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledOnce();
  });

  it('takes the request back and rethrows when the page cannot be opened', async () => {
    vi.spyOn(browser.runtime, 'openOptionsPage').mockRejectedValue(new Error('no page'));
    await expect(openOptionsAt('guide')).rejects.toThrow('no page');
    expect(await stored()).toBeUndefined();
  });
});

describe('openOptionsAt without session storage', () => {
  it('reports the failure to open the page, not the missing storage', async () => {
    const original = browser.storage.session;
    Object.defineProperty(browser.storage, 'session', { value: undefined, configurable: true });
    try {
      vi.spyOn(browser.runtime, 'openOptionsPage').mockRejectedValue(new Error('no page'));
      await expect(openOptionsAt('guide')).rejects.toThrow('no page');
    } finally {
      Object.defineProperty(browser.storage, 'session', { value: original, configurable: true });
    }
  });
});

describe('takePendingSection', () => {
  it('is null when nothing was asked', async () => {
    expect(await takePendingSection()).toBeNull();
  });

  it('returns the section once and clears it', async () => {
    await browser.storage.session.set({ [PENDING_SECTION_KEY]: 'keys' });
    expect(await takePendingSection()).toBe('keys');
    expect(await stored()).toBeUndefined();
    expect(await takePendingSection()).toBeNull();
  });

  it('drops a value that is not a known section', async () => {
    await browser.storage.session.set({ [PENDING_SECTION_KEY]: '../../x' });
    expect(await takePendingSection()).toBeNull();
    expect(await stored()).toBeUndefined();
  });

  it('is null when session storage cannot be read', async () => {
    vi.spyOn(browser.storage.session, 'get').mockRejectedValue(new Error('nope'));
    expect(await takePendingSection()).toBeNull();
  });
});
