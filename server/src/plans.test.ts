import { describe, expect, it } from 'vitest';
import { PLANS, TRIAL_ANALYSES, entitlement, isPlanName, planForLookupKey } from './plans';

const account = (
  fields: Partial<{ plan: string | null; subscription_status: string | null; trial_left: number }>,
) => ({ plan: null, subscription_status: null, trial_left: 15, ...fields });

describe('PLANS', () => {
  it('maps the Stripe price lookup keys to their plan and caps', () => {
    expect(PLANS.essentiel_monthly).toEqual({ plan: 'essentiel', monthCap: 300, dayCap: 40 });
    expect(PLANS.essentiel_yearly).toEqual({ plan: 'essentiel', monthCap: 300, dayCap: 40 });
    expect(PLANS.revendeur_monthly).toEqual({ plan: 'revendeur', monthCap: 1000, dayCap: 100 });
    expect(TRIAL_ANALYSES).toBe(15);
  });

  it('turns a lookup key into a plan name, null for anything else', () => {
    expect(planForLookupKey('essentiel_yearly')).toBe('essentiel');
    expect(planForLookupKey('revendeur_monthly')).toBe('revendeur');
    expect(planForLookupKey('gold_monthly')).toBeNull();
    expect(planForLookupKey('toString')).toBeNull();
    expect(planForLookupKey('constructor')).toBeNull();
  });

  it('knows plan names', () => {
    expect(isPlanName('essentiel')).toBe(true);
    expect(isPlanName('revendeur')).toBe(true);
    expect(isPlanName('gold')).toBe(false);
    expect(isPlanName('toString')).toBe(false);
    expect(isPlanName(null)).toBe(false);
  });
});

describe('entitlement', () => {
  it.each(['active', 'trialing', 'past_due'])('keeps the plan while the status is %s', (status) => {
    expect(entitlement(account({ plan: 'essentiel', subscription_status: status }))).toEqual({
      kind: 'plan',
      plan: 'essentiel',
      monthCap: 300,
      dayCap: 40,
    });
  });

  it('gives the revendeur caps', () => {
    expect(entitlement(account({ plan: 'revendeur', subscription_status: 'active' }))).toEqual({
      kind: 'plan',
      plan: 'revendeur',
      monthCap: 1000,
      dayCap: 100,
    });
  });

  it.each(['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])(
    'drops the plan when the status is %s',
    (status) => {
      expect(entitlement(account({ plan: 'essentiel', subscription_status: status }))).toEqual({
        kind: 'trial',
        left: 15,
      });
    },
  );

  it('ignores a plan it does not know, and a plan without a status', () => {
    expect(entitlement(account({ plan: 'gold', subscription_status: 'active' })).kind).toBe(
      'trial',
    );
    expect(entitlement(account({ plan: 'essentiel', subscription_status: null })).kind).toBe(
      'trial',
    );
    expect(entitlement(account({ plan: null, subscription_status: 'active' })).kind).toBe('trial');
  });

  it('uses the trial while it has analyses left, with no cap of its own', () => {
    expect(entitlement(account({ trial_left: 15 }))).toEqual({ kind: 'trial', left: 15 });
    expect(entitlement(account({ trial_left: 1 }))).toEqual({ kind: 'trial', left: 1 });
  });

  it('has nothing once the trial is used up and there is no plan', () => {
    expect(entitlement(account({ trial_left: 0 }))).toEqual({ kind: 'none' });
    expect(
      entitlement(account({ trial_left: 0, plan: 'essentiel', subscription_status: 'canceled' })),
    ).toEqual({ kind: 'none' });
  });

  it('prefers the plan over the trial', () => {
    expect(
      entitlement(account({ trial_left: 9, plan: 'essentiel', subscription_status: 'active' }))
        .kind,
    ).toBe('plan');
  });
});
