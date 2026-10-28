import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import type { Verdict } from '../model';
import {
  analyzeImageViaBackground,
  askGates,
  askVisionRemaining,
  openOptions,
  searchDeps,
  setVerdictBadge,
} from './client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('askGates', () => {
  it('returns the two gate words', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
      image: 'manual',
      ai: 'quota',
    } as never);
    expect(await askGates()).toEqual({ image: 'manual', ai: 'quota' });
  });

  it('passes on an expired subscription session as such, not as a missing key', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
      image: 'expired',
      ai: 'expired',
    } as never);
    expect(await askGates()).toEqual({ image: 'expired', ai: 'expired' });
  });

  it('counts anything else as no key', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ image: 'ok', ai: 3 } as never);
    expect(await askGates()).toEqual({ image: 'no_key', ai: 'no_key' });
  });

  it('counts a background that does not answer, or fails, as no key', async () => {
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    expect(await askGates()).toEqual({ image: 'no_key', ai: 'no_key' });
    spy.mockRejectedValue(new Error('Extension context invalidated.'));
    expect(await askGates()).toEqual({ image: 'no_key', ai: 'no_key' });
  });
});

describe('askVisionRemaining', () => {
  it('returns the credits left', async () => {
    const spy = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValue({ remaining: 12 } as never);
    expect(await askVisionRemaining()).toBe(12);
    expect(spy).toHaveBeenCalledWith({ type: 'getVisionUsage' });
  });

  it('knows no count without a cap, when the answer is odd, or when the message fails', async () => {
    const spy = vi.spyOn(browser.runtime, 'sendMessage');
    spy.mockResolvedValue({ remaining: null } as never);
    expect(await askVisionRemaining()).toBeNull();
    spy.mockResolvedValue({ remaining: '12' } as never);
    expect(await askVisionRemaining()).toBeNull();
    spy.mockResolvedValue(undefined as never);
    expect(await askVisionRemaining()).toBeNull();
    spy.mockRejectedValue(new Error('closed'));
    expect(await askVisionRemaining()).toBeNull();
  });
});

describe('requests of the grid and the card', () => {
  const PHOTO = 'https://images1.vinted.net/t/01_aa/310x430/aa.webp?s=1';

  it('sends the search with the flags that are set, and only those', async () => {
    const spy = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValue({ status: 'ok' } as never);
    await searchDeps.searchImage(PHOTO);
    await searchDeps.searchImage(PHOTO, true, true);
    expect(spy.mock.calls).toEqual([
      [{ type: 'searchImage', photoUrl: PHOTO }],
      [{ type: 'searchImage', photoUrl: PHOTO, cacheOnly: true, retry: true }],
    ]);
  });

  it('asks the background to analyse a photo', async () => {
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ ok: false } as never);
    await analyzeImageViaBackground(PHOTO);
    expect(spy).toHaveBeenCalledWith({ type: 'analyzeImage', url: PHOTO });
  });

  it('opens the options without ever rejecting', async () => {
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('closed'));
    expect(() => openOptions('credits')).not.toThrow();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith({ type: 'openOptions', section: 'credits' });
  });

  describe('setVerdictBadge', () => {
    it('sends the level and the title only', () => {
      const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
      // A whole verdict goes in, as the card has it: the lines do not travel.
      const verdict: Verdict = {
        level: 'review',
        title: 'À vérifier',
        lines: ['Une ligne.'],
        withoutImageSearch: false,
      };
      setVerdictBadge(verdict);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith({
        type: 'setVerdictBadge',
        verdict: { level: 'review', title: 'À vérifier' },
      });
    });

    it('sends null to clear the badge', () => {
      const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
      setVerdictBadge(null);
      expect(spy).toHaveBeenCalledWith({ type: 'setVerdictBadge', verdict: null });
    });

    // A rejection nobody handles would fail the whole run.
    it('never rejects nor throws, even when the extension context is gone', async () => {
      const spy = vi
        .spyOn(browser.runtime, 'sendMessage')
        .mockRejectedValue(new Error('Extension context invalidated.'));
      expect(() => setVerdictBadge({ level: 'clean', title: 'Rien de suspect' })).not.toThrow();
      spy.mockImplementation(() => {
        throw new Error('Extension context invalidated.');
      });
      expect(() => setVerdictBadge(null)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
