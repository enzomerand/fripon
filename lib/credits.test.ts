import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  CREDITS_LOCK,
  CREDIT_POLICY,
  WARN_RATIO,
  creditsKey,
  getUsage,
  nextReset,
  periodId,
  refund,
  reserve,
  usageState,
} from './credits';

/** Instants are written in UTC: the periods follow Google's Pacific midnight, not this machine. */
const at = (iso: string) => new Date(iso);
// 14:30 on 20 October 2026 in California (PDT, UTC-7).
const oct = at('2026-10-20T21:30:00Z');

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CREDIT_POLICY', () => {
  it('stops at the free tier by default', () => {
    expect(CREDIT_POLICY).toEqual({
      vision: { period: 'month', defaultCap: 1_000 },
      gemini: { period: 'day', defaultCap: 20 },
    });
    expect(WARN_RATIO).toBe(0.8);
  });
});

describe('periodId', () => {
  it('is YYYY-MM for a monthly provider and YYYY-MM-DD for a daily one', () => {
    expect(periodId('vision', oct)).toBe('2026-10');
    expect(periodId('gemini', oct)).toBe('2026-10-20');
  });

  it('follows the Pacific calendar, not UTC', () => {
    // 03:00 UTC on the 21st is still the 20th in California.
    expect(periodId('gemini', at('2026-10-21T03:00:00Z'))).toBe('2026-10-20');
    expect(periodId('vision', at('2026-11-01T03:00:00Z'))).toBe('2026-10');
  });

  it('changes at Pacific midnight, not before (summer time, UTC-7)', () => {
    expect(periodId('gemini', at('2026-10-21T06:59:59Z'))).toBe('2026-10-20');
    expect(periodId('gemini', at('2026-10-21T07:00:00Z'))).toBe('2026-10-21');
    expect(periodId('vision', at('2026-11-01T06:59:59Z'))).toBe('2026-10');
    expect(periodId('vision', at('2026-11-01T07:00:00Z'))).toBe('2026-11');
  });

  it('changes at Pacific midnight, not before (winter time, UTC-8)', () => {
    expect(periodId('gemini', at('2026-12-05T07:59:59Z'))).toBe('2026-12-04');
    expect(periodId('gemini', at('2026-12-05T08:00:00Z'))).toBe('2026-12-05');
    expect(periodId('vision', at('2027-01-01T07:59:59Z'))).toBe('2026-12');
    expect(periodId('vision', at('2027-01-01T08:00:00Z'))).toBe('2027-01');
  });

  it('zero-pads month and day', () => {
    expect(periodId('gemini', at('2027-01-05T20:00:00Z'))).toBe('2027-01-05');
  });
});

describe('nextReset', () => {
  it('is the 1st of next month at Pacific midnight for Vision', () => {
    expect(nextReset('vision', oct).toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });

  it('is tomorrow at Pacific midnight for Gemini', () => {
    expect(nextReset('gemini', oct).toISOString()).toBe('2026-10-21T07:00:00.000Z');
  });

  it('rolls over month and year ends', () => {
    expect(nextReset('gemini', at('2026-10-31T20:00:00Z')).toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
    expect(nextReset('vision', at('2026-12-15T12:00:00Z')).toISOString()).toBe(
      '2027-01-01T08:00:00.000Z',
    );
    expect(nextReset('gemini', at('2026-12-31T12:00:00Z')).toISOString()).toBe(
      '2027-01-01T08:00:00.000Z',
    );
  });

  describe('across a daylight saving change', () => {
    it('follows the clocks going back (1 Nov 2026 02:00, the day lasts 25 h)', () => {
      // Midnight is still PDT (UTC-7); the next one is PST (UTC-8).
      expect(nextReset('gemini', at('2026-11-01T12:00:00Z')).toISOString()).toBe(
        '2026-11-02T08:00:00.000Z',
      );
      expect(nextReset('gemini', at('2026-10-31T20:00:00Z')).toISOString()).toBe(
        '2026-11-01T07:00:00.000Z',
      );
      expect(nextReset('vision', at('2026-11-15T12:00:00Z')).toISOString()).toBe(
        '2026-12-01T08:00:00.000Z',
      );
    });

    it('follows the clocks going forward (14 Mar 2027 02:00, the day lasts 23 h)', () => {
      expect(nextReset('gemini', at('2027-03-13T20:00:00Z')).toISOString()).toBe(
        '2027-03-14T08:00:00.000Z',
      );
      expect(nextReset('gemini', at('2027-03-14T12:00:00Z')).toISOString()).toBe(
        '2027-03-15T07:00:00.000Z',
      );
      expect(nextReset('vision', at('2027-02-10T12:00:00Z')).toISOString()).toBe(
        '2027-03-01T08:00:00.000Z',
      );
      expect(nextReset('vision', at('2027-03-20T12:00:00Z')).toISOString()).toBe(
        '2027-04-01T07:00:00.000Z',
      );
    });

    it('always lands exactly on the first instant of the next period', () => {
      const windows = [
        ['2026-10-25T00:00:00Z', '2026-11-05T00:00:00Z'],
        ['2027-03-10T00:00:00Z', '2027-03-18T00:00:00Z'],
        ['2026-12-28T00:00:00Z', '2027-01-03T00:00:00Z'],
      ] as const;
      for (const [from, to] of windows) {
        for (let t = at(from).getTime(); t < at(to).getTime(); t += 3 * 3_600_000) {
          const now = new Date(t);
          for (const provider of ['vision', 'gemini'] as const) {
            const reset = nextReset(provider, now);
            expect(reset.getTime(), `${provider} ${now.toISOString()}`).toBeGreaterThan(t);
            expect(periodId(provider, new Date(reset.getTime() - 1))).toBe(periodId(provider, now));
            expect(periodId(provider, reset)).not.toBe(periodId(provider, now));
          }
        }
      }
    });
  });
});

describe('usageState', () => {
  it('never warns without a cap', () => {
    expect(usageState(0, null)).toBe('ok');
    expect(usageState(5_000_000, null)).toBe('ok');
  });

  it('warns from 80 % of the cap and is reached at the cap', () => {
    expect(usageState(799, 1_000)).toBe('ok');
    expect(usageState(800, 1_000)).toBe('warning');
    expect(usageState(999, 1_000)).toBe('warning');
    expect(usageState(1_000, 1_000)).toBe('reached');
    expect(usageState(1_200, 1_000)).toBe('reached');
  });

  it('rounds the warning threshold up', () => {
    expect(usageState(15, 20)).toBe('ok');
    expect(usageState(16, 20)).toBe('warning');
    expect(usageState(2, 3)).toBe('ok');
    expect(usageState(3, 3)).toBe('reached');
  });

  it('is not thrown off by float products (80 % of 55 is exactly 44)', () => {
    expect(usageState(43, 55)).toBe('ok');
    expect(usageState(44, 55)).toBe('warning');
  });

  it('is reached, not just warning, for a cap of 1', () => {
    expect(usageState(0, 1)).toBe('ok');
    expect(usageState(1, 1)).toBe('reached');
  });
});

describe('getUsage', () => {
  it('starts at zero, with everything left', async () => {
    expect(await getUsage('vision', 1_000, oct)).toEqual({
      used: 0,
      cap: 1_000,
      remaining: 1_000,
      state: 'ok',
      resetsAt: at('2026-11-01T07:00:00Z'),
    });
  });

  it('reads the counter of the current period only', async () => {
    await reserve('gemini', 4, null, oct);
    expect((await getUsage('gemini', 20, oct)).used).toBe(4);
    expect((await getUsage('gemini', 20, at('2026-10-21T07:00:00Z'))).used).toBe(0);
  });

  it('reports what is left, the state, and no remaining without a cap', async () => {
    await reserve('gemini', 16, null, oct);
    expect(await getUsage('gemini', 20, oct)).toMatchObject({ remaining: 4, state: 'warning' });
    await reserve('gemini', 4, null, oct);
    expect(await getUsage('gemini', 20, oct)).toMatchObject({ remaining: 0, state: 'reached' });
    expect(await getUsage('gemini', null, oct)).toMatchObject({ remaining: null, state: 'ok' });
  });

  it('never reports a negative remainder when the cap was lowered under the usage', async () => {
    await reserve('vision', 1_500, null, oct);
    expect(await getUsage('vision', 1_000, oct)).toMatchObject({
      used: 1_500,
      remaining: 0,
      state: 'reached',
    });
    expect(await getUsage('vision', 2_000, oct)).toMatchObject({ remaining: 500, state: 'ok' });
  });

  it('treats a corrupted counter as zero', async () => {
    await browser.storage.local.set({ [creditsKey('vision', oct)]: 'many' });
    expect((await getUsage('vision', 1_000, oct)).used).toBe(0);
    await browser.storage.local.set({ [creditsKey('vision', oct)]: -4 });
    expect((await getUsage('vision', 1_000, oct)).used).toBe(0);
  });
});

describe('reserve', () => {
  it('counts the credits under fripon:credits:v1:<provider>:<period>', async () => {
    await reserve('vision', 1, null, oct);
    await reserve('gemini', 1, null, oct);
    expect(await browser.storage.local.get(null)).toEqual({
      'fripon:credits:v1:vision:2026-10': 1,
      'fripon:credits:v1:gemini:2026-10-20': 1,
    });
  });

  it('says how many credits are left, or null without a cap', async () => {
    expect(await reserve('gemini', 1, 3, oct)).toEqual({ ok: true, remaining: 2 });
    expect(await reserve('gemini', 2, 3, oct)).toEqual({ ok: true, remaining: 0 });
    expect(await reserve('vision', 5, null, oct)).toEqual({ ok: true, remaining: null });
  });

  it('refuses once the cap is reached, and counts nothing', async () => {
    await reserve('gemini', 3, 3, oct);
    expect(await reserve('gemini', 1, 3, oct)).toEqual({ ok: false, remaining: 0 });
    expect((await getUsage('gemini', 3, oct)).used).toBe(3);
  });

  it('refuses a batch that does not fit, then accepts a smaller one', async () => {
    await reserve('vision', 4, 5, oct);
    expect(await reserve('vision', 2, 5, oct)).toEqual({ ok: false, remaining: 1 });
    expect((await getUsage('vision', 5, oct)).used).toBe(4);
    expect(await reserve('vision', 1, 5, oct)).toEqual({ ok: true, remaining: 0 });
  });

  it('applies the cap it is given at call time, so a raised cap lets calls through again', async () => {
    await reserve('vision', 3, 3, oct);
    expect((await reserve('vision', 1, 3, oct)).ok).toBe(false);
    expect((await reserve('vision', 1, 4, oct)).ok).toBe(true);
    expect((await reserve('vision', 1, null, oct)).ok).toBe(true);
  });

  it('lets only as many racing calls through as there are credits left', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => reserve('vision', 1, 5, oct)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(7);
    expect((await getUsage('vision', 5, oct)).used).toBe(5);
    // Each winner saw a different remainder: nobody got the same credit twice.
    expect(
      results
        .filter((r) => r.ok)
        .map((r) => r.remaining)
        .sort(),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it('counts every unit of racing calls without a cap', async () => {
    await Promise.all(Array.from({ length: 10 }, () => reserve('gemini', 1, null, oct)));
    expect((await getUsage('gemini', null, oct)).used).toBe(10);
  });

  it('takes the counter lock, so it holds across contexts too', async () => {
    const request = vi.fn(<T>(_name: string, callback: () => Promise<T>) => callback());
    vi.stubGlobal('navigator', { locks: { request } });
    await reserve('vision', 1, null, oct);
    await refund('vision', 1, oct);
    expect(request.mock.calls.map(([name]) => name)).toEqual([CREDITS_LOCK, CREDITS_LOCK]);
    expect(CREDITS_LOCK).toBe('fripon:credits');
  });

  it('reads the period inside the lock, not when it was called', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('2026-10-21T06:59:59Z'));
    const spend = reserve('gemini', 1, null);
    vi.setSystemTime(at('2026-10-21T07:00:01Z'));
    await spend;
    vi.useRealTimers();
    expect(Object.keys(await browser.storage.local.get(null))).toEqual([
      'fripon:credits:v1:gemini:2026-10-21',
    ]);
  });

  it.each([0, -1, 1.5, NaN])('rejects %s units', async (units) => {
    await expect(reserve('vision', units, null, oct)).rejects.toBeInstanceOf(RangeError);
    expect(await browser.storage.local.get(null)).toEqual({});
  });

  it.each([-1, 2.5, NaN])('rejects a cap of %s', async (cap) => {
    await expect(reserve('vision', 1, cap, oct)).rejects.toBeInstanceOf(RangeError);
    expect(await browser.storage.local.get(null)).toEqual({});
  });

  it('keeps working after a failed call', async () => {
    await expect(reserve('vision', 0, null, oct)).rejects.toThrow();
    expect(await reserve('vision', 2, null, oct)).toEqual({ ok: true, remaining: null });
  });

  describe('purge of old periods', () => {
    it('removes this provider’s earlier periods when the new one is created', async () => {
      await browser.storage.local.set({
        'fripon:credits:v1:gemini:2026-10-18': 9,
        'fripon:credits:v1:gemini:2026-10-19': 7,
        'fripon:credits:v1:vision:2026-09': 5,
        'fripon:seller:v2:www.vinted.fr:1': { a: 1 },
        'fripon:settings:v1': { mode: 'click' },
      });
      await reserve('gemini', 1, null, oct);
      expect(await browser.storage.local.get(null)).toEqual({
        'fripon:credits:v1:gemini:2026-10-20': 1,
        // Another provider's counter, and unrelated keys, stay.
        'fripon:credits:v1:vision:2026-09': 5,
        'fripon:seller:v2:www.vinted.fr:1': { a: 1 },
        'fripon:settings:v1': { mode: 'click' },
      });
    });

    it('keeps a counter of a later period (a clock that went back)', async () => {
      await browser.storage.local.set({ 'fripon:credits:v1:gemini:2026-10-21': 3 });
      await reserve('gemini', 1, null, oct);
      expect(await browser.storage.local.get(null)).toEqual({
        'fripon:credits:v1:gemini:2026-10-20': 1,
        'fripon:credits:v1:gemini:2026-10-21': 3,
      });
    });

    it('purges a month counter at the start of the next month, in Pacific time', async () => {
      await reserve('vision', 5, null, at('2026-10-31T20:00:00Z'));
      await reserve('vision', 1, null, at('2026-11-01T07:00:00Z'));
      expect(await browser.storage.local.get(null)).toEqual({
        'fripon:credits:v1:vision:2026-11': 1,
      });
    });

    it('does not scan the storage on an ordinary spend, only when the period is created', async () => {
      const get = vi.spyOn(browser.storage.local, 'get');
      await reserve('gemini', 1, null, oct);
      const scans = () => get.mock.calls.filter(([keys]) => keys === null).length;
      expect(scans()).toBe(1);

      await browser.storage.local.set({ 'fripon:credits:v1:gemini:2026-10-01': 4 });
      await reserve('gemini', 1, null, oct);
      await reserve('gemini', 1, null, oct);
      expect(scans()).toBe(1);
      // Every spend reads the one key it needs.
      expect(
        get.mock.calls
          .filter(([keys]) => keys !== null)
          .every(([keys]) => typeof keys === 'string'),
      ).toBe(true);
      expect(await browser.storage.local.get('fripon:credits:v1:gemini:2026-10-01')).toEqual({
        'fripon:credits:v1:gemini:2026-10-01': 4,
      });
    });

    it('does not scan on a refused call either', async () => {
      const get = vi.spyOn(browser.storage.local, 'get');
      await reserve('gemini', 1, 0, oct);
      expect(get.mock.calls.some(([keys]) => keys === null)).toBe(false);
      expect(await browser.storage.local.get(null)).toEqual({});
    });
  });
});

describe('refund', () => {
  it('gives credits back', async () => {
    await reserve('vision', 5, null, oct);
    await refund('vision', 2, oct);
    expect((await getUsage('vision', 1_000, oct)).used).toBe(3);
  });

  it('puts the credit back within reach of a capped provider', async () => {
    await reserve('gemini', 3, 3, oct);
    expect((await reserve('gemini', 1, 3, oct)).ok).toBe(false);
    await refund('gemini', 1, oct);
    expect(await reserve('gemini', 1, 3, oct)).toEqual({ ok: true, remaining: 0 });
  });

  it('never goes below zero', async () => {
    await reserve('vision', 1, null, oct);
    await refund('vision', 5, oct);
    expect((await getUsage('vision', 1_000, oct)).used).toBe(0);
  });

  it('does nothing, and creates nothing, when the period has no counter', async () => {
    await refund('vision', 1, oct);
    expect(await browser.storage.local.get(null)).toEqual({});
    // A counter of another period is not touched either.
    await reserve('vision', 3, null, at('2026-09-10T20:00:00Z'));
    await refund('vision', 1, oct);
    expect(await browser.storage.local.get(null)).toEqual({
      'fripon:credits:v1:vision:2026-09': 3,
    });
  });

  it('is serialised with reserve', async () => {
    await reserve('vision', 10, null, oct);
    await Promise.all([
      refund('vision', 1, oct),
      reserve('vision', 1, null, oct),
      refund('vision', 1, oct),
      reserve('vision', 1, null, oct),
    ]);
    expect((await getUsage('vision', 1_000, oct)).used).toBe(10);
  });

  it.each([0, -1, 1.5, NaN])('rejects %s units', async (units) => {
    await expect(refund('vision', units, oct)).rejects.toBeInstanceOf(RangeError);
  });
});
