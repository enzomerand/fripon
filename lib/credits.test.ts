import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  CREDIT_POLICY,
  WARN_RATIO,
  creditsKey,
  getUsage,
  nextReset,
  periodId,
  recordSpend,
  usageState,
} from './credits';

// Local time on purpose: periods roll over at the user's midnight.
const oct = new Date(2026, 9, 20, 14, 30);

beforeEach(() => {
  fakeBrowser.reset();
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

  it('zero-pads month and day', () => {
    const jan = new Date(2027, 0, 5, 23, 59, 59);
    expect(periodId('vision', jan)).toBe('2027-01');
    expect(periodId('gemini', jan)).toBe('2027-01-05');
  });

  it('changes at local midnight, not before', () => {
    expect(periodId('gemini', new Date(2026, 9, 20, 23, 59, 59))).toBe('2026-10-20');
    expect(periodId('gemini', new Date(2026, 9, 21, 0, 0, 0))).toBe('2026-10-21');
    expect(periodId('vision', new Date(2026, 9, 31, 23, 59, 59))).toBe('2026-10');
    expect(periodId('vision', new Date(2026, 10, 1, 0, 0, 0))).toBe('2026-11');
  });
});

describe('nextReset', () => {
  it('is the 1st of next month at local midnight for Vision', () => {
    expect(nextReset('vision', oct)).toEqual(new Date(2026, 10, 1));
  });

  it('is tomorrow at local midnight for Gemini', () => {
    expect(nextReset('gemini', oct)).toEqual(new Date(2026, 9, 21));
  });

  it('rolls over month and year ends', () => {
    expect(nextReset('gemini', new Date(2026, 9, 31, 12))).toEqual(new Date(2026, 10, 1));
    expect(nextReset('vision', new Date(2026, 11, 15))).toEqual(new Date(2027, 0, 1));
    expect(nextReset('gemini', new Date(2026, 11, 31, 23, 59))).toEqual(new Date(2027, 0, 1));
  });

  it('is always strictly after now and lands in the period periodId reports next', () => {
    for (const provider of ['vision', 'gemini'] as const) {
      const reset = nextReset(provider, oct);
      expect(reset.getTime()).toBeGreaterThan(oct.getTime());
      expect(periodId(provider, reset)).not.toBe(periodId(provider, oct));
      expect(periodId(provider, new Date(reset.getTime() - 1))).toBe(periodId(provider, oct));
    }
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
    // 80 % of 20 is exactly 16; of 3, 2.4 -> 3.
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
  it('starts at zero', async () => {
    expect(await getUsage('vision', 1_000, oct)).toEqual({
      used: 0,
      cap: 1_000,
      state: 'ok',
      resetsAt: new Date(2026, 10, 1),
    });
  });

  it('reads the counter of the current period only', async () => {
    await recordSpend('gemini', 4, oct);
    expect((await getUsage('gemini', 20, oct)).used).toBe(4);
    expect((await getUsage('gemini', 20, new Date(2026, 9, 21, 0, 0))).used).toBe(0);
  });

  it('reports the warning and reached states', async () => {
    await recordSpend('gemini', 16, oct);
    expect((await getUsage('gemini', 20, oct)).state).toBe('warning');
    await recordSpend('gemini', 4, oct);
    expect((await getUsage('gemini', 20, oct)).state).toBe('reached');
  });

  it('applies the cap it is given, null meaning none', async () => {
    await recordSpend('vision', 1_500, oct);
    expect((await getUsage('vision', 1_000, oct)).state).toBe('reached');
    expect(await getUsage('vision', 2_000, oct)).toMatchObject({ used: 1_500, state: 'ok' });
    expect(await getUsage('vision', null, oct)).toMatchObject({ cap: null, state: 'ok' });
  });

  it('treats a corrupted counter as zero', async () => {
    await browser.storage.local.set({ [creditsKey('vision', oct)]: 'many' });
    expect((await getUsage('vision', 1_000, oct)).used).toBe(0);
    await browser.storage.local.set({ [creditsKey('vision', oct)]: -4 });
    expect((await getUsage('vision', 1_000, oct)).used).toBe(0);
  });
});

describe('recordSpend', () => {
  it('stores the counter under fripon:credits:v1:<provider>:<period>', async () => {
    await recordSpend('vision', 1, oct);
    await recordSpend('gemini', 1, oct);
    const stored = await browser.storage.local.get(null);
    expect(stored).toEqual({
      'fripon:credits:v1:vision:2026-10': 1,
      'fripon:credits:v1:gemini:2026-10-20': 1,
    });
  });

  it('adds one unit by default and returns the new total', async () => {
    expect(await recordSpend('vision', undefined, oct)).toBe(1);
    expect(await recordSpend('vision', 3, oct)).toBe(4);
    expect((await getUsage('vision', 1_000, oct)).used).toBe(4);
  });

  it('counts concurrent spends all together', async () => {
    const totals = await Promise.all(
      Array.from({ length: 10 }, () => recordSpend('vision', 1, oct)),
    );
    expect(totals.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await getUsage('vision', 1_000, oct)).used).toBe(10);
  });

  it('starts a fresh counter in a new period and prunes the old ones of that provider', async () => {
    await recordSpend('gemini', 7, new Date(2026, 9, 19, 10));
    await recordSpend('gemini', 9, new Date(2026, 9, 20, 10));
    await recordSpend('vision', 5, new Date(2026, 8, 3, 10));
    await recordSpend('gemini', 1, new Date(2026, 9, 21, 10));
    expect(await browser.storage.local.get(null)).toEqual({
      // Vision's September counter belongs to another provider: untouched.
      'fripon:credits:v1:vision:2026-09': 5,
      'fripon:credits:v1:gemini:2026-10-21': 1,
    });
  });

  it('leaves unrelated storage keys alone', async () => {
    await browser.storage.local.set({
      'fripon:seller:v2:www.vinted.fr:1': { a: 1 },
      'fripon:settings:v1': { mode: 'click' },
    });
    await recordSpend('vision', 1, oct);
    expect(await browser.storage.local.get(null)).toMatchObject({
      'fripon:seller:v2:www.vinted.fr:1': { a: 1 },
      'fripon:settings:v1': { mode: 'click' },
    });
  });

  it.each([0, -1, 1.5, NaN])('rejects %s units', async (units) => {
    await expect(recordSpend('vision', units, oct)).rejects.toBeInstanceOf(RangeError);
    expect(await browser.storage.local.get(null)).toEqual({});
  });

  it('keeps working after a failed spend', async () => {
    await expect(recordSpend('vision', 0, oct)).rejects.toThrow();
    expect(await recordSpend('vision', 2, oct)).toBe(2);
  });
});
