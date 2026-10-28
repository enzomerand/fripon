import { describe, expect, it } from 'vitest';
import { PLAN_USAGE } from './test-helpers';
import { parseMe, parseStatus, parseUsage } from './types';

const TRIAL_USAGE = {
  kind: 'trial',
  month: { used: 4, cap: null },
  day: { used: 1, cap: null },
  trialLeft: 11,
};

describe('parseUsage', () => {
  it('reads what the server sends for a plan and for the trial', () => {
    expect(parseUsage(PLAN_USAGE)).toEqual(PLAN_USAGE);
    expect(parseUsage(TRIAL_USAGE)).toEqual(TRIAL_USAGE);
    expect(parseUsage({ ...TRIAL_USAGE, kind: 'none', trialLeft: 0 })?.kind).toBe('none');
  });

  it('drops what it does not know (extra fields stay out of the status)', () => {
    expect(parseUsage({ ...PLAN_USAGE, secret: 'x' })).toEqual(PLAN_USAGE);
  });

  it.each([
    ['not an object', 'plan'],
    ['an unknown kind', { ...PLAN_USAGE, kind: 'gold' }],
    ['a plan this version does not know', { ...PLAN_USAGE, plan: 'platine' }],
    ['a plan without its name', { ...PLAN_USAGE, plan: undefined }],
    ['a negative count', { ...PLAN_USAGE, month: { used: -1, cap: 300 } }],
    ['a fractional count', { ...PLAN_USAGE, day: { used: 1.5, cap: 40 } }],
    ['a count that is a string', { ...PLAN_USAGE, trialLeft: '15' }],
    ['a missing window', { ...PLAN_USAGE, month: undefined }],
    ['a cap that is neither a number nor null', { ...PLAN_USAGE, day: { used: 1, cap: 'x' } }],
  ])('refuses %s', (_name, raw) => {
    expect(parseUsage(raw)).toBeNull();
  });
});

describe('parseMe', () => {
  it('reads the email, the usage and the subscription', () => {
    const subscription = { status: 'active', periodEnd: 1_800_000_000_000 };
    expect(parseMe({ email: 'a@b.fr', ...PLAN_USAGE, subscription })).toEqual({
      email: 'a@b.fr',
      usage: PLAN_USAGE,
      subscription,
    });
    expect(
      parseMe({ email: 'a@b.fr', ...TRIAL_USAGE, subscription: null })?.subscription,
    ).toBeNull();
  });

  it('accepts a subscription without a period end', () => {
    expect(
      parseMe({ email: 'a@b.fr', ...PLAN_USAGE, subscription: { status: 'active' } })?.subscription,
    ).toEqual({ status: 'active', periodEnd: null });
  });

  it.each([
    ['no email', { ...PLAN_USAGE, subscription: null }],
    ['an empty email', { email: '', ...PLAN_USAGE, subscription: null }],
    ['no usage', { email: 'a@b.fr', subscription: null }],
    ['a subscription without a status', { email: 'a@b.fr', ...PLAN_USAGE, subscription: {} }],
    ['an undefined subscription', { email: 'a@b.fr', ...PLAN_USAGE }],
  ])('refuses an answer with %s', (_name, raw) => {
    expect(parseMe(raw)).toBeNull();
  });
});

describe('parseStatus', () => {
  it('reads back what the background stores, with or without a usage', () => {
    const status = { email: 'a@b.fr', usage: PLAN_USAGE, subscription: null, checkedAt: 5 };
    expect(parseStatus(status)).toEqual(status);
    const unknown = { email: 'a@b.fr', usage: null, subscription: null, checkedAt: 0 };
    expect(parseStatus(unknown)).toEqual(unknown);
  });

  it.each([
    ['nothing', undefined],
    [
      'a damaged usage',
      { email: 'a@b.fr', usage: { kind: 'plan' }, subscription: null, checkedAt: 1 },
    ],
    ['no date', { email: 'a@b.fr', usage: null, subscription: null }],
    ['no email', { usage: null, subscription: null, checkedAt: 1 }],
  ])('refuses %s', (_name, raw) => {
    expect(parseStatus(raw)).toBeNull();
  });
});
