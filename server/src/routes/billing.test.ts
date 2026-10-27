import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { purgeExpired, STRIPE_EVENT_KEEP_MS } from '../maintenance';
import { PRICE_CACHE_MS, WEBHOOK_EVENTS, type StripeApi, type StripeSubscription } from '../stripe';
import { createTestApp, insertAccount, post, signIn, testConfig } from '../test-helpers';
import type { TestApp } from '../test-helpers';
import type { Account } from '../db';
import {
  CANCEL_MESSAGE,
  DONE_MESSAGE,
  TERMS_MESSAGE,
  WEBHOOK_MAX_BODY_BYTES,
  registerBillingRoutes,
} from './billing';

const WEBHOOK_SECRET = 'whsec_test_secret_0001';
const PUBLIC_URL = 'https://cloud.fripon.test';
/** 2026-11-20T12:00:00Z, in seconds as Stripe says it. */
const PERIOD_END_SECONDS = 1_795_176_000;

/** A real client, only to sign test payloads and to verify them: the one thing the fake does not fake. */
const signer = new Stripe('sk_test_signer');

interface FakeStripe extends StripeApi {
  customersCreated: Array<{ params: Stripe.CustomerCreateParams; idempotencyKey?: string }>;
  checkoutCreated: Stripe.Checkout.SessionCreateParams[];
  portalCreated: Stripe.BillingPortal.SessionCreateParams[];
  priceLookups: string[][];
  retrieved: string[];
  /** The subscriptions Stripe "has", by id. */
  subscriptionsById: Map<string, StripeSubscription>;
  /** The next call of that kind rejects with this. */
  failWith: Partial<Record<'checkout' | 'portal' | 'customer' | 'retrieve', Error>>;
  /** Lookup keys that have no active price. */
  missingPrices: Set<string>;
}

function fakeStripe(): FakeStripe {
  let customers = 0;
  const stripe: FakeStripe = {
    customersCreated: [],
    checkoutCreated: [],
    portalCreated: [],
    priceLookups: [],
    retrieved: [],
    subscriptionsById: new Map(),
    failWith: {},
    missingPrices: new Set(),
    customers: {
      async create(params, options) {
        if (stripe.failWith.customer) throw stripe.failWith.customer;
        stripe.customersCreated.push({ params, idempotencyKey: options?.idempotencyKey });
        return { id: `cus_new_${++customers}` };
      },
    },
    prices: {
      async list(params) {
        stripe.priceLookups.push(params.lookup_keys);
        return {
          data: params.lookup_keys
            .filter((key) => !stripe.missingPrices.has(key))
            .map((key) => ({ id: `price_${key}`, lookup_key: key })),
        };
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          if (stripe.failWith.checkout) throw stripe.failWith.checkout;
          stripe.checkoutCreated.push(params);
          return { url: 'https://checkout.stripe.test/c/pay/cs_test_1' };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          if (stripe.failWith.portal) throw stripe.failWith.portal;
          stripe.portalCreated.push(params);
          return { url: 'https://billing.stripe.test/p/session/test_1' };
        },
      },
    },
    subscriptions: {
      async retrieve(id) {
        stripe.retrieved.push(id);
        if (stripe.failWith.retrieve) throw stripe.failWith.retrieve;
        const found = stripe.subscriptionsById.get(id);
        if (!found)
          throw Object.assign(new Error(`No such subscription: ${id}`), {
            code: 'resource_missing',
          });
        return found;
      },
    },
    webhooks: signer.webhooks,
  };
  return stripe;
}

/** A subscription as Stripe reports it; `overrides` sets any field. */
function subscription(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    metadata: {},
    items: {
      data: [
        { price: { lookup_key: 'essentiel_monthly' }, current_period_end: PERIOD_END_SECONDS },
      ],
    },
    ...overrides,
  };
}

function withLookupKey(lookupKey: string | null): StripeSubscription['items'] {
  return { data: [{ price: { lookup_key: lookupKey }, current_period_end: PERIOD_END_SECONDS }] };
}

let eventCounter = 0;

function stripeEvent(type: string, object: unknown, id = `evt_${++eventCounter}`) {
  return { id, object: 'event', type, data: { object } };
}

/** Sends an event signed like Stripe signs it (or with whatever header `signature` says). */
function deliver(
  t: TestApp,
  event: object,
  options: { secret?: string; signature?: string | null; body?: string } = {},
) {
  const body = options.body ?? JSON.stringify(event);
  const signature =
    options.signature === undefined
      ? signer.webhooks.generateTestHeaderString({
          payload: body,
          secret: options.secret ?? WEBHOOK_SECRET,
        })
      : options.signature;
  return t.app.request('/v1/stripe/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'stripe-signature': signature }),
    },
    body,
  });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function row(t: TestApp, id: string): Account {
  return t.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account;
}

function eventCount(t: TestApp): number {
  return (t.db.prepare('SELECT COUNT(*) AS n FROM stripe_events').get() as { n: number }).n;
}

interface Me {
  kind: string;
  plan?: string;
  month: { cap: number | null };
  day: { cap: number | null };
  subscription: { status: string; periodEnd: number | null } | null;
}

async function me(t: TestApp, token: string): Promise<Me> {
  const response = await t.app.request('/v1/me', { headers: bearer(token) });
  return (await response.json()) as Me;
}

let errorLog: MockInstance<typeof console.error>;
beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function setup(overrides: Parameters<typeof testConfig>[0] = {}) {
  const stripe = fakeStripe();
  const t = createTestApp(
    [registerBillingRoutes(stripe)],
    testConfig({ publicUrl: PUBLIC_URL, stripeWebhookSecret: WEBHOOK_SECRET, ...overrides }),
  );
  return { ...t, stripe };
}

/** An account (signed in, with a token) the webhook can find by its id. */
async function signedInAccount(t: TestApp, overrides: Partial<Account> = {}) {
  const email = `buyer-${Math.random().toString(36).slice(2)}@example.com`;
  const token = await signIn(t, email);
  const account = t.db.prepare('SELECT * FROM accounts WHERE email = ?').get(email) as Account;
  if (Object.keys(overrides).length > 0) {
    const merged = { ...account, ...overrides };
    t.db
      .prepare(
        `UPDATE accounts SET trial_left = @trial_left, stripe_customer_id = @stripe_customer_id,
           subscription_id = @subscription_id, plan = @plan, subscription_status = @subscription_status,
           period_end = @period_end WHERE id = @id`,
      )
      .run(merged);
  }
  return { token, id: account.id, email };
}

describe('POST /v1/billing/checkout', () => {
  it('needs a signed-in account', async () => {
    const t = setup();
    expect((await post(t.app, '/v1/billing/checkout', { price: 'essentiel_monthly' })).status).toBe(
      401,
    );
  });

  it('creates a Checkout Session for the account and the price, and answers its URL', async () => {
    const t = setup();
    const buyer = await signedInAccount(t);

    const response = await post(
      t.app,
      '/v1/billing/checkout',
      { price: 'essentiel_yearly' },
      bearer(buyer.token),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://checkout.stripe.test/c/pay/cs_test_1' });
    expect(t.stripe.priceLookups).toEqual([['essentiel_yearly']]);
    expect(t.stripe.checkoutCreated).toHaveLength(1);
    expect(t.stripe.checkoutCreated[0]).toMatchObject({
      mode: 'subscription',
      customer: 'cus_new_1',
      client_reference_id: buyer.id,
      line_items: [{ price: 'price_essentiel_yearly', quantity: 1 }],
      subscription_data: { metadata: { account_id: buyer.id } },
      allow_promotion_codes: true,
      locale: 'fr',
      success_url: `${PUBLIC_URL}/billing/done`,
      cancel_url: `${PUBLIC_URL}/billing/cancel`,
    });
    // Whatever the SDK or Stripe's settings decide, the payment methods are never pinned here.
    expect(t.stripe.checkoutCreated[0]).not.toHaveProperty('payment_method_types');
  });

  it('creates the Stripe customer once, with the email and the account id, and reuses it', async () => {
    const t = setup();
    const buyer = await signedInAccount(t);

    await post(t.app, '/v1/billing/checkout', { price: 'essentiel_monthly' }, bearer(buyer.token));
    await post(t.app, '/v1/billing/checkout', { price: 'revendeur_monthly' }, bearer(buyer.token));

    expect(t.stripe.customersCreated).toEqual([
      {
        params: { email: buyer.email, metadata: { account_id: buyer.id } },
        idempotencyKey: `fripon-customer-${buyer.id}`,
      },
    ]);
    expect(row(t, buyer.id).stripe_customer_id).toBe('cus_new_1');
    expect(t.stripe.checkoutCreated.map((params) => params.customer)).toEqual([
      'cus_new_1',
      'cus_new_1',
    ]);
  });

  it('uses the customer an account already has', async () => {
    const t = setup();
    const buyer = await signedInAccount(t, { stripe_customer_id: 'cus_known' });

    await post(t.app, '/v1/billing/checkout', { price: 'essentiel_monthly' }, bearer(buyer.token));

    expect(t.stripe.customersCreated).toHaveLength(0);
    expect(t.stripe.checkoutCreated[0]?.customer).toBe('cus_known');
  });

  it.each([
    [{}],
    [{ price: 'pro_monthly' }],
    [{ price: 42 }],
    [{ price: 'toString' }],
    [{ price: 'constructor' }],
    [{ price: ['essentiel_monthly'] }],
  ])('refuses %j', async (body) => {
    const t = setup();
    const buyer = await signedInAccount(t);

    const response = await post(t.app, '/v1/billing/checkout', body, bearer(buyer.token));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(t.stripe.customersCreated).toHaveLength(0);
    expect(t.stripe.checkoutCreated).toHaveLength(0);
  });

  it('refuses a body that is not JSON', async () => {
    const t = setup();
    const buyer = await signedInAccount(t);
    const response = await t.app.request('/v1/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...bearer(buyer.token) },
      body: 'essentiel_monthly',
    });
    expect(response.status).toBe(400);
  });

  it.each(['active', 'trialing', 'past_due'])(
    'sends an account whose subscription is %s to the portal instead',
    async (status) => {
      const t = setup();
      const subscriber = await signedInAccount(t, {
        stripe_customer_id: 'cus_paying',
        subscription_id: 'sub_paying',
        plan: 'essentiel',
        subscription_status: status,
      });
      const response = await post(
        t.app,
        '/v1/billing/checkout',
        { price: 'revendeur_monthly' },
        bearer(subscriber.token),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        url: 'https://billing.stripe.test/p/session/test_1',
      });
      expect(t.stripe.portalCreated).toEqual([
        { customer: 'cus_paying', return_url: `${PUBLIC_URL}/billing/done`, locale: 'fr' },
      ]);
      expect(t.stripe.checkoutCreated).toHaveLength(0);
    },
  );

  it.each(['canceled', 'incomplete_expired', 'unpaid'])(
    'lets an account whose subscription is %s subscribe again',
    async (status) => {
      const t = setup();
      const buyer = await signedInAccount(t, {
        stripe_customer_id: 'cus_back',
        subscription_id: 'sub_old',
        plan: 'essentiel',
        subscription_status: status,
      });

      await post(
        t.app,
        '/v1/billing/checkout',
        { price: 'essentiel_monthly' },
        bearer(buyer.token),
      );

      expect(t.stripe.checkoutCreated).toHaveLength(1);
      expect(t.stripe.checkoutCreated[0]?.customer).toBe('cus_back');
      expect(t.stripe.portalCreated).toHaveLength(0);
    },
  );

  it('asks for the terms only when the configuration says so', async () => {
    const without = setup();
    const buyer = await signedInAccount(without);
    await post(
      without.app,
      '/v1/billing/checkout',
      { price: 'essentiel_monthly' },
      bearer(buyer.token),
    );
    expect(without.stripe.checkoutCreated[0]).not.toHaveProperty('consent_collection');
    expect(without.stripe.checkoutCreated[0]).not.toHaveProperty('custom_text');

    const required = setup({ stripeRequireTerms: true });
    const other = await signedInAccount(required);
    await post(
      required.app,
      '/v1/billing/checkout',
      { price: 'essentiel_monthly' },
      bearer(other.token),
    );
    expect(required.stripe.checkoutCreated[0]).toMatchObject({
      consent_collection: { terms_of_service: 'required' },
      custom_text: { terms_of_service_acceptance: { message: TERMS_MESSAGE } },
    });
    expect(TERMS_MESSAGE).toBe(
      "J'accepte que Fripon démarre tout de suite et je renonce à mon droit de rétractation de 14 jours.",
    );
  });

  it('builds the return URLs from a PUBLIC_URL that ends with a slash', async () => {
    const t = setup({ publicUrl: `${PUBLIC_URL}/` });
    const buyer = await signedInAccount(t);
    await post(t.app, '/v1/billing/checkout', { price: 'essentiel_monthly' }, bearer(buyer.token));
    expect(t.stripe.checkoutCreated[0]).toMatchObject({
      success_url: `${PUBLIC_URL}/billing/done`,
      cancel_url: `${PUBLIC_URL}/billing/cancel`,
    });
  });

  it('remembers a price id for ten minutes, then asks again', async () => {
    const t = setup();
    const buyer = await signedInAccount(t);
    const buy = () =>
      post(t.app, '/v1/billing/checkout', { price: 'essentiel_monthly' }, bearer(buyer.token));

    await buy();
    t.clock.advance(PRICE_CACHE_MS - 1000);
    await buy();
    expect(t.stripe.priceLookups).toHaveLength(1);

    t.clock.advance(2000);
    await buy();
    expect(t.stripe.priceLookups).toHaveLength(2);
  });

  it('answers 502 when the price does not exist in Stripe, and does not remember the miss', async () => {
    const t = setup();
    const buyer = await signedInAccount(t);
    t.stripe.missingPrices.add('essentiel_monthly');

    const response = await post(
      t.app,
      '/v1/billing/checkout',
      { price: 'essentiel_monthly' },
      bearer(buyer.token),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'upstream' });
    expect(t.stripe.checkoutCreated).toHaveLength(0);

    t.stripe.missingPrices.clear();
    expect(
      (
        await post(
          t.app,
          '/v1/billing/checkout',
          { price: 'essentiel_monthly' },
          bearer(buyer.token),
        )
      ).status,
    ).toBe(200);
  });

  it.each(['checkout', 'customer'] as const)(
    'answers 502 when Stripe fails at %s',
    async (step) => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.failWith[step] = new Error('Stripe is down');

      const response = await post(
        t.app,
        '/v1/billing/checkout',
        { price: 'essentiel_monthly' },
        bearer(buyer.token),
      );

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'upstream' });
      expect(errorLog).toHaveBeenCalled();
    },
  );

  it('is never cached', async () => {
    const t = setup();
    const buyer = await signedInAccount(t);
    const response = await post(
      t.app,
      '/v1/billing/checkout',
      { price: 'essentiel_monthly' },
      bearer(buyer.token),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /v1/billing/portal', () => {
  it('needs a signed-in account', async () => {
    const t = setup();
    expect((await post(t.app, '/v1/billing/portal', {})).status).toBe(401);
  });

  it('answers 409 for an account that never had a Stripe customer', async () => {
    const t = setup();
    const buyer = await signedInAccount(t);

    const response = await post(t.app, '/v1/billing/portal', {}, bearer(buyer.token));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'no_customer' });
    expect(t.stripe.portalCreated).toHaveLength(0);
  });

  it('answers the portal URL of the customer, back to the done page', async () => {
    const t = setup();
    const buyer = await signedInAccount(t, { stripe_customer_id: 'cus_1' });

    const response = await post(t.app, '/v1/billing/portal', {}, bearer(buyer.token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://billing.stripe.test/p/session/test_1' });
    expect(t.stripe.portalCreated).toEqual([
      { customer: 'cus_1', return_url: `${PUBLIC_URL}/billing/done`, locale: 'fr' },
    ]);
  });

  it('opens the configured portal configuration when there is one', async () => {
    const t = setup({ stripePortalConfiguration: 'bpc_fripon' });
    const buyer = await signedInAccount(t, { stripe_customer_id: 'cus_1' });

    await post(t.app, '/v1/billing/portal', {}, bearer(buyer.token));

    expect(t.stripe.portalCreated[0]).toMatchObject({
      customer: 'cus_1',
      configuration: 'bpc_fripon',
    });
  });

  it('answers 502 when Stripe fails', async () => {
    const t = setup();
    const buyer = await signedInAccount(t, { stripe_customer_id: 'cus_1' });
    t.stripe.failWith.portal = new Error('Stripe is down');

    const response = await post(t.app, '/v1/billing/portal', {}, bearer(buyer.token));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'upstream' });
  });
});

describe('GET /billing/done and /billing/cancel', () => {
  it.each([
    ['/billing/done', DONE_MESSAGE],
    ['/billing/cancel', CANCEL_MESSAGE],
  ])('%s is a small French page with no script', async (path, message) => {
    const t = setup();

    const response = await t.app.request(path);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(html).toContain('lang="fr"');
    expect(html).toContain(message);
    expect(html).not.toMatch(/<script/i);
  });

  it('say the exact words', () => {
    expect(DONE_MESSAGE).toBe(
      "C'est tout bon ! Ton abonnement Fripon est actif. Tu peux fermer cet onglet et retourner sur Vinted.",
    );
    expect(CANCEL_MESSAGE).toBe("Paiement annulé. Rien n'a été débité. Tu peux fermer cet onglet.");
  });
});

describe('POST /v1/stripe/webhook', () => {
  describe('signature', () => {
    it('answers 400 to a missing, malformed or wrong signature, and writes nothing', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set('sub_1', subscription({ metadata: { account_id: buyer.id } }));
      const event = stripeEvent('customer.subscription.created', { id: 'sub_1' });

      for (const response of [
        await deliver(t, event, { signature: null }),
        await deliver(t, event, { signature: 'garbage' }),
        await deliver(t, event, { secret: 'whsec_somebody_else' }),
        await deliver(t, event, {
          signature: signer.webhooks.generateTestHeaderString({
            payload: '{}',
            secret: WEBHOOK_SECRET,
          }),
        }),
      ]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_signature' });
      }

      expect(t.stripe.retrieved).toEqual([]);
      expect(eventCount(t)).toBe(0);
      expect(row(t, buyer.id).subscription_status).toBeNull();
    });

    it('answers 400 to a signature that is too old', async () => {
      const t = setup();
      const body = JSON.stringify(stripeEvent('customer.subscription.created', { id: 'sub_1' }));
      const signature = signer.webhooks.generateTestHeaderString({
        payload: body,
        secret: WEBHOOK_SECRET,
        timestamp: Math.floor(Date.now() / 1000) - 3600,
      });
      expect((await deliver(t, {}, { body, signature })).status).toBe(400);
    });

    it('verifies the bytes it received, not a copy of them', async () => {
      const t = setup();
      const body = JSON.stringify(stripeEvent('invoice.paid', { id: 'in_1' }));
      const signature = signer.webhooks.generateTestHeaderString({
        payload: body,
        secret: WEBHOOK_SECRET,
      });
      // The same JSON with other whitespace is another payload: its signature does not match.
      const reformatted = JSON.stringify(JSON.parse(body), null, 2);
      expect((await deliver(t, {}, { body: reformatted, signature })).status).toBe(400);
      expect((await deliver(t, {}, { body, signature })).status).toBe(200);
    });

    it('accepts nothing when no signing secret is configured', async () => {
      const t = setup({ stripeWebhookSecret: '' });
      const event = stripeEvent('invoice.paid', { id: 'in_1' });
      expect((await deliver(t, event)).status).toBe(400);
      expect((await deliver(t, event, { secret: '' })).status).toBe(400);
    });
  });

  describe('body size', () => {
    it('accepts a body well over the 16 KB of the extension routes', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set('sub_1', subscription({ metadata: { account_id: buyer.id } }));
      const event = stripeEvent('customer.subscription.updated', {
        id: 'sub_1',
        description: 'x'.repeat(40_000),
      });
      expect(JSON.stringify(event).length).toBeGreaterThan(16 * 1024);

      const response = await deliver(t, event);

      expect(response.status).toBe(200);
      expect(row(t, buyer.id).subscription_status).toBe('active');
    });

    it('refuses a body above 256 KB before reading it', async () => {
      const t = setup();
      const event = stripeEvent('invoice.paid', {
        description: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES),
      });

      const response = await deliver(t, event);

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'payload_too_large' });
    });

    it('keeps the 16 KB limit on the other routes', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      const response = await post(
        t.app,
        '/v1/billing/checkout',
        { price: 'essentiel_monthly', padding: 'x'.repeat(20_000) },
        bearer(buyer.token),
      );
      expect(response.status).toBe(413);
    });
  });

  describe('idempotency', () => {
    it('ignores an event it has already handled', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set('sub_1', subscription({ metadata: { account_id: buyer.id } }));
      const event = stripeEvent('customer.subscription.created', { id: 'sub_1' }, 'evt_same');

      expect((await deliver(t, event)).status).toBe(200);
      t.stripe.subscriptionsById.set(
        'sub_1',
        subscription({ metadata: { account_id: buyer.id }, status: 'canceled' }),
      );
      const again = await deliver(t, event);

      expect(again.status).toBe(200);
      expect(t.stripe.retrieved).toEqual(['sub_1']);
      // The second delivery did nothing: the row still holds what the first one wrote.
      expect(row(t, buyer.id).subscription_status).toBe('active');
      expect(eventCount(t)).toBe(1);
    });

    it('lets Stripe retry an event that failed, and handles it when the retry comes', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set('sub_1', subscription({ metadata: { account_id: buyer.id } }));
      const event = stripeEvent('customer.subscription.created', { id: 'sub_1' }, 'evt_retry');

      t.stripe.failWith.retrieve = new Error('Stripe is down');
      expect((await deliver(t, event)).status).toBe(500);
      expect(eventCount(t)).toBe(0);
      expect(row(t, buyer.id).subscription_status).toBeNull();

      delete t.stripe.failWith.retrieve;
      expect((await deliver(t, event)).status).toBe(200);
      expect(row(t, buyer.id).subscription_status).toBe('active');
      expect(eventCount(t)).toBe(1);
    });

    it('forgets events after a month, no sooner', () => {
      const t = setup();
      const now = t.clock.ms();
      t.db
        .prepare('INSERT INTO stripe_events (id, received_at) VALUES (?, ?)')
        .run('evt_old', now - STRIPE_EVENT_KEEP_MS);
      t.db
        .prepare('INSERT INTO stripe_events (id, received_at) VALUES (?, ?)')
        .run('evt_recent', now - STRIPE_EVENT_KEEP_MS + 1000);

      purgeExpired(t.db, now);

      expect(t.db.prepare('SELECT id FROM stripe_events').all()).toEqual([{ id: 'evt_recent' }]);
    });
  });

  describe('checkout.session.completed', () => {
    it('links the customer to the account named by the session and syncs the subscription', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set(
        'sub_9',
        subscription({ id: 'sub_9', customer: 'cus_9', metadata: { account_id: buyer.id } }),
      );

      const response = await deliver(
        t,
        stripeEvent('checkout.session.completed', {
          id: 'cs_test_1',
          mode: 'subscription',
          client_reference_id: buyer.id,
          customer: 'cus_9',
          subscription: 'sub_9',
        }),
      );

      expect(response.status).toBe(200);
      expect(row(t, buyer.id)).toMatchObject({
        stripe_customer_id: 'cus_9',
        subscription_id: 'sub_9',
        plan: 'essentiel',
        subscription_status: 'active',
        period_end: PERIOD_END_SECONDS * 1000,
      });
      expect(await me(t, buyer.token)).toMatchObject({
        kind: 'plan',
        plan: 'essentiel',
        month: { cap: 300 },
        day: { cap: 40 },
        subscription: { status: 'active', periodEnd: PERIOD_END_SECONDS * 1000 },
      });
    });

    it('finds the account through the session even when the subscription carries no metadata', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set('sub_9', subscription({ id: 'sub_9', customer: 'cus_9' }));

      await deliver(
        t,
        stripeEvent('checkout.session.completed', {
          client_reference_id: buyer.id,
          customer: 'cus_9',
          subscription: 'sub_9',
        }),
      );

      expect(row(t, buyer.id)).toMatchObject({ stripe_customer_id: 'cus_9', plan: 'essentiel' });
    });

    it('does not move a customer the account already has, nor take one from another account', async () => {
      const t = setup();
      const owner = await signedInAccount(t, { stripe_customer_id: 'cus_mine' });
      const other = await signedInAccount(t);

      const first = await deliver(
        t,
        stripeEvent('checkout.session.completed', {
          client_reference_id: owner.id,
          customer: 'cus_new',
          subscription: null,
        }),
      );
      const second = await deliver(
        t,
        stripeEvent('checkout.session.completed', {
          client_reference_id: other.id,
          customer: 'cus_mine',
          subscription: null,
        }),
      );

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(row(t, owner.id).stripe_customer_id).toBe('cus_mine');
      expect(row(t, other.id).stripe_customer_id).toBeNull();
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('could not be linked'),
        expect.anything(),
      );
    });

    it('is fine with a session that has no subscription', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);

      const response = await deliver(
        t,
        stripeEvent('checkout.session.completed', {
          mode: 'payment',
          client_reference_id: buyer.id,
          customer: 'cus_9',
          subscription: null,
        }),
      );

      expect(response.status).toBe(200);
      expect(t.stripe.retrieved).toEqual([]);
    });
  });

  describe('customer.subscription.*', () => {
    it('stores what the subscription says, read again from Stripe and not from the event', async () => {
      const t = setup();
      const buyer = await signedInAccount(t, { stripe_customer_id: 'cus_1' });
      t.stripe.subscriptionsById.set('sub_1', subscription({ status: 'trialing' }));

      await deliver(
        t,
        // The event is out of date on purpose: only its id counts.
        stripeEvent('customer.subscription.created', {
          id: 'sub_1',
          status: 'incomplete',
          customer: 'cus_1',
        }),
      );

      expect(t.stripe.retrieved).toEqual(['sub_1']);
      expect(row(t, buyer.id)).toMatchObject({
        subscription_id: 'sub_1',
        plan: 'essentiel',
        subscription_status: 'trialing',
      });
    });

    it('switches the plan and the caps when the subscription changes price', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set('sub_1', subscription({ metadata: { account_id: buyer.id } }));
      await deliver(t, stripeEvent('customer.subscription.created', { id: 'sub_1' }));
      expect(await me(t, buyer.token)).toMatchObject({
        plan: 'essentiel',
        month: { cap: 300 },
        day: { cap: 40 },
      });

      t.stripe.subscriptionsById.set(
        'sub_1',
        subscription({
          metadata: { account_id: buyer.id },
          items: withLookupKey('revendeur_monthly'),
        }),
      );
      await deliver(t, stripeEvent('customer.subscription.updated', { id: 'sub_1' }));

      expect(await me(t, buyer.token)).toMatchObject({
        kind: 'plan',
        plan: 'revendeur',
        month: { cap: 1000 },
        day: { cap: 100 },
      });
      expect(row(t, buyer.id).plan).toBe('revendeur');
    });

    it('maps the yearly price to the same plan as the monthly one', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set(
        'sub_1',
        subscription({
          metadata: { account_id: buyer.id },
          items: withLookupKey('essentiel_yearly'),
        }),
      );

      await deliver(t, stripeEvent('customer.subscription.created', { id: 'sub_1' }));

      expect(await me(t, buyer.token)).toMatchObject({ plan: 'essentiel', month: { cap: 300 } });
    });

    it('keeps the row but marks it canceled when the subscription is deleted, and the trial counter takes over', async () => {
      const t = setup();
      const buyer = await signedInAccount(t, { trial_left: 7 });
      t.stripe.subscriptionsById.set('sub_1', subscription({ metadata: { account_id: buyer.id } }));
      await deliver(t, stripeEvent('customer.subscription.created', { id: 'sub_1' }));
      expect((await me(t, buyer.token)).kind).toBe('plan');

      t.stripe.subscriptionsById.set(
        'sub_1',
        subscription({ metadata: { account_id: buyer.id }, status: 'canceled' }),
      );
      await deliver(t, stripeEvent('customer.subscription.deleted', { id: 'sub_1' }));

      expect(row(t, buyer.id)).toMatchObject({
        subscription_id: 'sub_1',
        subscription_status: 'canceled',
      });
      expect(await me(t, buyer.token)).toMatchObject({
        kind: 'trial',
        subscription: { status: 'canceled' },
      });
    });

    it('reads the period end from the item, falling back to the subscription, else null', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      const sync = async (value: StripeSubscription) => {
        t.stripe.subscriptionsById.set('sub_1', { ...value, metadata: { account_id: buyer.id } });
        await deliver(t, stripeEvent('customer.subscription.updated', { id: 'sub_1' }));
        return row(t, buyer.id).period_end;
      };

      // The item's value wins over the top-level one.
      expect(await sync(subscription({ current_period_end: 1 }))).toBe(PERIOD_END_SECONDS * 1000);
      // An API version that still has it on the subscription only.
      expect(
        await sync(
          subscription({
            current_period_end: 1_800_000_000,
            items: { data: [{ price: { lookup_key: 'essentiel_monthly' } }] },
          }),
        ),
      ).toBe(1_800_000_000_000);
      expect(
        await sync(
          subscription({ items: { data: [{ price: { lookup_key: 'essentiel_monthly' } }] } }),
        ),
      ).toBeNull();
    });

    it('stores no plan, and says so in the log, for a price Fripon does not sell', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set(
        'sub_1',
        subscription({
          metadata: { account_id: buyer.id },
          items: withLookupKey('enterprise_monthly'),
        }),
      );

      const response = await deliver(
        t,
        stripeEvent('customer.subscription.created', { id: 'sub_1' }),
      );

      expect(response.status).toBe(200);
      expect(row(t, buyer.id)).toMatchObject({ plan: null, subscription_status: 'active' });
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('enterprise_monthly'));
      // No known plan, no quota: the trial is all there is.
      expect((await me(t, buyer.token)).kind).toBe('trial');
    });

    it('stores no plan for a price without a lookup key', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set(
        'sub_1',
        subscription({ metadata: { account_id: buyer.id }, items: withLookupKey(null) }),
      );

      await deliver(t, stripeEvent('customer.subscription.created', { id: 'sub_1' }));

      expect(row(t, buyer.id).plan).toBeNull();
    });

    it('finds the account by its customer when the subscription has no metadata', async () => {
      const t = setup();
      const buyer = await signedInAccount(t, { stripe_customer_id: 'cus_1' });
      t.stripe.subscriptionsById.set('sub_1', subscription({ customer: { id: 'cus_1' } }));

      await deliver(t, stripeEvent('customer.subscription.updated', { id: 'sub_1' }));

      expect(row(t, buyer.id)).toMatchObject({ subscription_id: 'sub_1', plan: 'essentiel' });
    });

    it('prefers the account in the metadata, and then remembers its customer', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set(
        'sub_1',
        subscription({ customer: 'cus_77', metadata: { account_id: buyer.id } }),
      );

      await deliver(t, stripeEvent('customer.subscription.created', { id: 'sub_1' }));

      expect(row(t, buyer.id).stripe_customer_id).toBe('cus_77');
    });

    it('answers 200 and writes nothing for a subscription that belongs to no account', async () => {
      const t = setup();
      const bystander = insertAccount(t.db);
      t.stripe.subscriptionsById.set(
        'sub_1',
        subscription({ customer: 'cus_unknown', metadata: { account_id: 'no-such-account' } }),
      );

      const response = await deliver(
        t,
        stripeEvent('customer.subscription.created', { id: 'sub_1' }),
      );

      expect(response.status).toBe(200);
      expect(row(t, bystander.id).subscription_status).toBeNull();
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('belongs to no account'));
      expect(eventCount(t)).toBe(1);
    });

    it('answers 200 for a subscription Stripe no longer knows, so it never retries it', async () => {
      const t = setup();

      const response = await deliver(
        t,
        stripeEvent('customer.subscription.deleted', { id: 'sub_gone' }),
      );

      expect(response.status).toBe(200);
      expect(t.stripe.retrieved).toEqual(['sub_gone']);
    });

    it('does not let a late event about an older subscription wipe the one being paid', async () => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set(
        'sub_new',
        subscription({
          id: 'sub_new',
          metadata: { account_id: buyer.id },
          items: withLookupKey('revendeur_monthly'),
        }),
      );
      t.stripe.subscriptionsById.set(
        'sub_old',
        subscription({ id: 'sub_old', status: 'canceled', metadata: { account_id: buyer.id } }),
      );

      await deliver(t, stripeEvent('customer.subscription.created', { id: 'sub_new' }));
      await deliver(t, stripeEvent('customer.subscription.deleted', { id: 'sub_old' }));

      expect(row(t, buyer.id)).toMatchObject({
        subscription_id: 'sub_new',
        plan: 'revendeur',
        subscription_status: 'active',
      });
    });

    it('lets a new subscription replace a canceled one', async () => {
      const t = setup();
      const buyer = await signedInAccount(t, {
        stripe_customer_id: 'cus_1',
        subscription_id: 'sub_old',
        plan: 'essentiel',
        subscription_status: 'canceled',
      });
      t.stripe.subscriptionsById.set(
        'sub_new',
        subscription({ id: 'sub_new', items: withLookupKey('revendeur_monthly') }),
      );

      await deliver(t, stripeEvent('customer.subscription.created', { id: 'sub_new' }));

      expect(row(t, buyer.id)).toMatchObject({
        subscription_id: 'sub_new',
        plan: 'revendeur',
        subscription_status: 'active',
      });
    });
  });

  describe('the events the endpoint subscribes to', () => {
    it.each([...WEBHOOK_EVENTS])('%s is handled: the subscription is read again', async (type) => {
      const t = setup();
      const buyer = await signedInAccount(t);
      t.stripe.subscriptionsById.set('sub_1', subscription({ metadata: { account_id: buyer.id } }));
      const object = type.startsWith('checkout.')
        ? { client_reference_id: buyer.id, customer: 'cus_1', subscription: 'sub_1' }
        : { id: 'sub_1' };

      expect((await deliver(t, stripeEvent(type, object))).status).toBe(200);

      expect(t.stripe.retrieved).toEqual(['sub_1']);
      expect(row(t, buyer.id).subscription_status).toBe('active');
    });
  });

  describe('other events', () => {
    it.each(['invoice.paid', 'customer.updated', 'charge.refunded'])(
      'acknowledges %s and does nothing',
      async (type) => {
        const t = setup();
        const buyer = await signedInAccount(t);

        const response = await deliver(t, stripeEvent(type, { id: 'obj_1', customer: 'cus_1' }));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ received: true });
        expect(t.stripe.retrieved).toEqual([]);
        expect(row(t, buyer.id).subscription_status).toBeNull();
      },
    );

    it('is fine with an event whose object is not what it should be', async () => {
      const t = setup();
      expect((await deliver(t, stripeEvent('customer.subscription.updated', null))).status).toBe(
        200,
      );
      expect((await deliver(t, stripeEvent('checkout.session.completed', 'oops'))).status).toBe(
        200,
      );
      expect(t.stripe.retrieved).toEqual([]);
    });
  });
});
