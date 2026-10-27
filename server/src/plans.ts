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
 * The plans by the lookup key of their Stripe price: what Checkout asks for (the price to buy is
 * found by its key), and the last resort of `planOfPrice` when a price carries no `metadata.plan`.
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

/** The fields of a subscription item's price that tell which plan it is. */
export interface PlanPrice {
  lookup_key: string | null;
  metadata?: Record<string, string> | null;
  product?: string | { metadata?: Record<string, string> | null } | null;
}

/**
 * The plan a subscription's price stands for. Read from `metadata.plan` of the price, then of its
 * product (`stripe:setup` sets both), and only then from the lookup key: a price change moves the
 * lookup key (`transfer_lookup_key`) to the new price, and the subscribers still on the old one
 * must keep their plan. Null for a price Fripon does not sell.
 */
export function planOfPrice(price: PlanPrice): PlanName | null {
  const fromPrice = price.metadata?.plan;
  if (isPlanName(fromPrice)) return fromPrice;
  const product = price.product;
  if (typeof product === 'object' && product !== null) {
    const fromProduct = product.metadata?.plan;
    if (isPlanName(fromProduct)) return fromProduct;
  }
  return price.lookup_key === null ? null : planForLookupKey(price.lookup_key);
}

/**
 * Stripe subscription statuses that keep the plan's quota. `past_due` stays on: Stripe retries the
 * payment for a few days, and the subscription becomes `canceled` or `unpaid` if it never works.
 */
export const ACTIVE_STATUSES: readonly string[] = ['active', 'trialing', 'past_due'];

/**
 * How long past the end of its period a subscription keeps its quota when the webhook that renews
 * (or ends) it did not arrive. Stripe retries a webhook for three days: past that, an `active`
 * status nobody renewed is a lost event, and the quota stops instead of lasting forever.
 */
export const PERIOD_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** What an account may use right now. */
export type Entitlement =
  | { kind: 'plan'; plan: PlanName; monthCap: number; dayCap: number }
  | { kind: 'trial'; left: number }
  | { kind: 'none' };

/**
 * A subscription with a known plan wins; otherwise the trial, while it has analyses left. The
 * subscription must also be within its period: `period_end` unknown (null), or not more than
 * `PERIOD_GRACE_MS` in the past.
 */
export function entitlement(
  account: Pick<Account, 'plan' | 'subscription_status' | 'trial_left' | 'period_end'>,
  now: Date,
): Entitlement {
  if (
    account.subscription_status !== null &&
    ACTIVE_STATUSES.includes(account.subscription_status) &&
    isPlanName(account.plan) &&
    (account.period_end === null || account.period_end > now.getTime() - PERIOD_GRACE_MS)
  ) {
    return { kind: 'plan', plan: account.plan, ...PLAN_CAPS[account.plan] };
  }
  if (account.trial_left > 0) return { kind: 'trial', left: account.trial_left };
  return { kind: 'none' };
}
