import type { Account } from './db';

/** Analyses of the free trial, once per account, no card. The trial has no daily cap of its own. */
export const TRIAL_ANALYSES = 15;

export type PlanName = 'essentiel' | 'revendeur';

/** What a plan allows: analyses per calendar month and per day (Paris time). */
export const PLAN_CAPS: Record<PlanName, { monthCap: number; dayCap: number }> = {
  essentiel: { monthCap: 300, dayCap: 40 },
  revendeur: { monthCap: 1_000, dayCap: 100 },
};

/**
 * The plans by the lookup key of their Stripe price (set on the price in the Stripe dashboard).
 * The billing code turns a subscription's price into a plan with it and stores `plan`.
 */
export const PLANS = {
  essentiel_monthly: { plan: 'essentiel', ...PLAN_CAPS.essentiel },
  essentiel_yearly: { plan: 'essentiel', ...PLAN_CAPS.essentiel },
  revendeur_monthly: { plan: 'revendeur', ...PLAN_CAPS.revendeur },
} as const satisfies Record<string, { plan: PlanName; monthCap: number; dayCap: number }>;

export type PriceLookupKey = keyof typeof PLANS;

export function isPlanName(value: unknown): value is PlanName {
  return typeof value === 'string' && Object.hasOwn(PLAN_CAPS, value);
}

/** The plan a Stripe price lookup key stands for, null for a key Fripon does not sell. */
export function planForLookupKey(key: string): PlanName | null {
  return Object.hasOwn(PLANS, key) ? PLANS[key as PriceLookupKey].plan : null;
}

/**
 * Stripe subscription statuses that keep the plan's quota. `past_due` stays on: Stripe retries the
 * payment for a few days, and the subscription becomes `canceled` or `unpaid` if it never works.
 */
export const ACTIVE_STATUSES: readonly string[] = ['active', 'trialing', 'past_due'];

/** What an account may use right now. */
export type Entitlement =
  | { kind: 'plan'; plan: PlanName; monthCap: number; dayCap: number }
  | { kind: 'trial'; left: number }
  | { kind: 'none' };

/** A subscription with a known plan wins; otherwise the trial, while it has analyses left. */
export function entitlement(
  account: Pick<Account, 'plan' | 'subscription_status' | 'trial_left'>,
): Entitlement {
  if (
    account.subscription_status !== null &&
    ACTIVE_STATUSES.includes(account.subscription_status) &&
    isPlanName(account.plan)
  ) {
    return { kind: 'plan', plan: account.plan, ...PLAN_CAPS[account.plan] };
  }
  if (account.trial_left > 0) return { kind: 'trial', left: account.trial_left };
  return { kind: 'none' };
}
