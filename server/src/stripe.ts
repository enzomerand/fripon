import Stripe from 'stripe';

/**
 * Everything the billing routes ask of Stripe, and nothing more: only the calls and the fields the
 * server uses. The real one is the official SDK (`realStripe`); tests pass a fake, except for
 * `webhooks`, which they take from a real client to sign and verify real payloads.
 *
 * The shapes are the SDK's own where a request is built (a wrong parameter fails the typecheck) and
 * narrow where an answer is read (a fake only has to provide what the server looks at).
 */
export interface StripeApi {
  customers: {
    create(
      params: Stripe.CustomerCreateParams,
      options?: { idempotencyKey?: string },
    ): Promise<{ id: string }>;
  };
  prices: {
    list(params: {
      lookup_keys: string[];
      active: boolean;
      limit?: number;
    }): Promise<{ data: Array<{ id: string; lookup_key: string | null }> }>;
  };
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<{ url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }>;
    };
  };
  subscriptions: {
    /** `expand` asks for the price's product too (see `SUBSCRIPTION_EXPAND`). */
    retrieve(id: string, params?: { expand?: string[] }): Promise<StripeSubscription>;
    /** A customer's subscriptions, the canceled ones left out (Stripe's default). */
    list(params: { customer: string; limit?: number }): Promise<{ data: StripeSubscription[] }>;
    /** Ends a subscription at once (an abandoned `incomplete` one, which must never be paid later). */
    cancel(id: string): Promise<{ id: string }>;
  };
  webhooks: {
    constructEventAsync(
      payload: string | Uint8Array,
      header: string,
      secret: string,
    ): Promise<StripeEvent>;
  };
}

/**
 * What a subscription is retrieved with: the product of each price, so that the plan can be read
 * from the product's metadata when the price has none (and no lookup key any more).
 */
export const SUBSCRIPTION_EXPAND = ['items.data.price.product'];

/** The part of a subscription the server reads. */
export interface StripeSubscription {
  id: string;
  /** Stripe's own word: `active`, `trialing`, `past_due`, `canceled`... */
  status: string;
  /** Seconds. Tells which of two subscriptions of one account is the most recent. */
  created: number;
  customer: string | { id: string };
  metadata: Record<string, string>;
  items: {
    data: Array<{
      price: {
        lookup_key: string | null;
        /** `plan` is set by `stripe:setup` on every price and product it makes. */
        metadata?: Record<string, string> | null;
        /** The id, or the product itself when it was expanded (`SUBSCRIPTION_EXPAND`). */
        product?: string | { id?: string; metadata?: Record<string, string> | null } | null;
      };
      /** Seconds. Since API version 2025-03-31 the period lives on the item, not on the subscription. */
      current_period_end?: number;
    }>;
  };
  /** Seconds. Older API versions only; the item's value wins. */
  current_period_end?: number;
}

/** A verified event; `data.object` is read defensively by the handlers. */
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

/**
 * The events the webhook endpoint must be subscribed to: the ones `registerBillingRoutes` handles
 * (`billing.test.ts` checks both lists stay the same). Everything else Stripe sends is ignored.
 */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  // Only tells the owner (see `alerts.ts`): nothing is cancelled or refunded automatically.
  'charge.dispute.created',
] as const;

/** The API version the SDK's types describe, pinned so a Stripe default change never reshapes answers. */
export const STRIPE_API_VERSION = Stripe.API_VERSION;

/**
 * The official client. A blank key (development without Stripe) still builds one: the first call
 * is then refused by Stripe and logged, and signature checks need no key at all.
 */
export function realStripe(secretKey: string): StripeApi {
  return new Stripe(secretKey === '' ? 'sk_test_not_configured' : secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'Fripon Cloud' },
  });
}

/** Stripe's answer for an object it does not (or no longer) have. */
export function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'resource_missing'
  );
}

/**
 * Stripe does not know the customer: it was made in another mode (a test customer once the keys
 * are live) or deleted. `resource_missing` says it for any object, so the customer is told apart by
 * the parameter Stripe blames, or by its message.
 */
export function isCustomerMissing(error: unknown): boolean {
  if (!isMissing(error)) return false;
  const { param, message } = error as { param?: unknown; message?: unknown };
  return param === 'customer' || (typeof message === 'string' && /No such customer/i.test(message));
}

/** The id of a Stripe reference that is either the id or the expanded object; null for anything else. */
export function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === 'string' && id !== '') return id;
  }
  return null;
}

/** How long a price id is remembered: prices change by a deliberate act, rarely. */
export const PRICE_CACHE_MS = 10 * 60 * 1000;

/**
 * The id of the active Stripe price that holds a lookup key, remembered for `PRICE_CACHE_MS`.
 * A key with no active price (the setup script was not run) is not remembered, and throws.
 */
export function createPriceResolver(
  stripe: Pick<StripeApi, 'prices'>,
  now: () => number,
): (lookupKey: string) => Promise<string> {
  const known = new Map<string, { id: string; until: number }>();

  return async (lookupKey) => {
    const hit = known.get(lookupKey);
    if (hit && hit.until > now()) return hit.id;

    const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const price = data.find((candidate) => candidate.lookup_key === lookupKey);
    if (!price) throw new Error(`No active Stripe price has the lookup key "${lookupKey}"`);

    known.set(lookupKey, { id: price.id, until: now() + PRICE_CACHE_MS });
    return price.id;
  };
}
