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
  subscriptions: { retrieve(id: string): Promise<StripeSubscription> };
  webhooks: {
    constructEventAsync(
      payload: string | Uint8Array,
      header: string,
      secret: string,
    ): Promise<StripeEvent>;
  };
}

/** The part of a subscription the server reads. */
export interface StripeSubscription {
  id: string;
  /** Stripe's own word: `active`, `trialing`, `past_due`, `canceled`... */
  status: string;
  customer: string | { id: string };
  metadata: Record<string, string>;
  items: {
    data: Array<{
      price: { lookup_key: string | null };
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
