import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { PLANS } from './plans';
import { STRIPE_API_VERSION, WEBHOOK_EVENTS } from './stripe';
import {
  PRICE_SPECS,
  PRODUCT_SPECS,
  checkedKey,
  parseArgs,
  runSetup,
  type SetupApi,
  type SetupSummary,
} from './stripe-setup';

interface StoredPrice {
  id: string;
  active: boolean;
  lookup_key: string | null;
  unit_amount: number | null;
  currency: string;
  tax_behavior: string | null;
  recurring: { interval: string; interval_count: number } | null;
  product: string;
}

/** A Stripe account in memory: lists page by two, creating makes ids, a lookup key can be moved. */
function fakeAccount() {
  let counter = 0;
  const id = (prefix: string) => `${prefix}_${++counter}`;
  const state = {
    products: [] as Array<{ id: string; name: string; metadata: Record<string, string> }>,
    prices: [] as StoredPrice[],
    portals: [] as Array<{ id: string; metadata: Record<string, string> | null }>,
    webhooks: [] as Array<{ id: string; url: string; enabled_events: string[] }>,
  };
  const calls = {
    productCreates: [] as Stripe.ProductCreateParams[],
    priceCreates: [] as Stripe.PriceCreateParams[],
    portalCreates: [] as Stripe.BillingPortal.ConfigurationCreateParams[],
    portalUpdates: [] as Array<{
      id: string;
      params: Stripe.BillingPortal.ConfigurationUpdateParams;
    }>,
    webhookCreates: [] as Stripe.WebhookEndpointCreateParams[],
    webhookUpdates: [] as Array<{ id: string; params: Stripe.WebhookEndpointUpdateParams }>,
  };

  function page<T extends { id: string }>(items: T[], after: string | undefined) {
    const size = 2;
    const start = after === undefined ? 0 : items.findIndex((item) => item.id === after) + 1;
    return { data: items.slice(start, start + size), has_more: start + size < items.length };
  }

  const api: SetupApi = {
    products: {
      async list(params) {
        return page(state.products, params.starting_after);
      },
      async create(params) {
        calls.productCreates.push(params);
        const product = {
          id: id('prod'),
          name: params.name,
          metadata: { ...(params.metadata as Record<string, string>) },
        };
        state.products.push(product);
        return product;
      },
    },
    prices: {
      async list(params) {
        const held = state.prices.filter((price) =>
          params.lookup_keys.includes(price.lookup_key ?? ''),
        );
        return { data: held, has_more: false };
      },
      async create(params) {
        calls.priceCreates.push(params);
        if (params.lookup_key !== undefined) {
          const holder = state.prices.find((price) => price.lookup_key === params.lookup_key);
          if (holder && !params.transfer_lookup_key) throw new Error('lookup key already in use');
          if (holder) holder.lookup_key = null;
        }
        const price: StoredPrice = {
          id: id('price'),
          active: true,
          lookup_key: params.lookup_key ?? null,
          unit_amount: params.unit_amount ?? null,
          currency: params.currency,
          tax_behavior: params.tax_behavior ?? null,
          recurring: params.recurring
            ? { interval: params.recurring.interval, interval_count: 1 }
            : null,
          product: params.product as string,
        };
        state.prices.push(price);
        return price;
      },
    },
    billingPortal: {
      configurations: {
        async list(params) {
          return page(state.portals, params.starting_after);
        },
        async create(params) {
          calls.portalCreates.push(params);
          const portal = {
            id: id('bpc'),
            metadata: (params.metadata as Record<string, string>) ?? null,
          };
          state.portals.push(portal);
          return portal;
        },
        async update(portalId, params) {
          calls.portalUpdates.push({ id: portalId, params });
          return state.portals.find(
            (portal) => portal.id === portalId,
          ) as (typeof state.portals)[number];
        },
      },
    },
    webhookEndpoints: {
      async list(params) {
        return page(state.webhooks, params.starting_after);
      },
      async create(params) {
        calls.webhookCreates.push(params);
        const endpoint = {
          id: id('we'),
          url: params.url,
          enabled_events: [...params.enabled_events],
        };
        state.webhooks.push(endpoint);
        return { ...endpoint, secret: 'whsec_created_once' };
      },
      async update(webhookId, params) {
        calls.webhookUpdates.push({ id: webhookId, params });
        const endpoint = state.webhooks.find(
          (candidate) => candidate.id === webhookId,
        ) as (typeof state.webhooks)[number];
        if (params.enabled_events) endpoint.enabled_events = [...params.enabled_events];
        return endpoint;
      },
    },
  };
  return { api, state, calls };
}

const run = (account: ReturnType<typeof fakeAccount>, webhookUrl: string | null = null) => {
  const lines: string[] = [];
  return runSetup(account.api, { webhookUrl }, (line) => lines.push(line)).then((summary) => ({
    summary,
    lines,
  }));
};

/** The product id a plan's prices live on. */
const productOf = (summary: SetupSummary, plan: 'essentiel' | 'revendeur') =>
  summary.products.find((product) => product.plan === plan)?.id as string;

const outcomes = (summary: SetupSummary) =>
  Object.fromEntries(summary.prices.map((price) => [price.lookupKey, price.outcome]));

describe('runSetup', () => {
  it('creates one product per plan, the three prices and the portal on an empty account', async () => {
    const account = fakeAccount();

    const { summary, lines } = await run(account);

    // « Fripon Essentiel » and « Fripon Revendeur »: what the portal and the invoices will say.
    expect(account.calls.productCreates).toHaveLength(2);
    expect(account.calls.productCreates[0]).toMatchObject({
      name: 'Fripon Essentiel',
      metadata: { fripon: 'cloud', plan: 'essentiel' },
    });
    expect(account.calls.productCreates[1]).toMatchObject({
      name: 'Fripon Revendeur',
      metadata: { fripon: 'cloud', plan: 'revendeur' },
    });
    expect(summary.products.map(({ plan, outcome }) => [plan, outcome])).toEqual([
      ['essentiel', 'created'],
      ['revendeur', 'created'],
    ]);
    const productId = productOf(summary, 'essentiel');
    const revendeurId = productOf(summary, 'revendeur');
    expect(productId).not.toBe(revendeurId);

    expect(account.calls.priceCreates).toEqual([
      expect.objectContaining({
        product: productId,
        currency: 'eur',
        unit_amount: 299,
        recurring: { interval: 'month' },
        lookup_key: 'essentiel_monthly',
        tax_behavior: 'inclusive',
      }),
      expect.objectContaining({
        product: productId,
        currency: 'eur',
        unit_amount: 2999,
        recurring: { interval: 'year' },
        lookup_key: 'essentiel_yearly',
        tax_behavior: 'inclusive',
      }),
      expect.objectContaining({
        product: revendeurId,
        currency: 'eur',
        unit_amount: 699,
        recurring: { interval: 'month' },
        lookup_key: 'revendeur_monthly',
        tax_behavior: 'inclusive',
      }),
    ]);
    for (const create of account.calls.priceCreates)
      expect(create).not.toHaveProperty('transfer_lookup_key');
    expect(outcomes(summary)).toEqual({
      essentiel_monthly: 'created',
      essentiel_yearly: 'created',
      revendeur_monthly: 'created',
    });

    expect(account.calls.portalCreates).toHaveLength(1);
    expect(summary.webhook).toBeNull();
    expect(lines.join('\n')).toContain(summary.portal.id);
  });

  it("sells exactly the prices plans.ts knows, each on its plan's product", () => {
    expect(Object.keys(PRICE_SPECS).sort()).toEqual(Object.keys(PLANS).sort());
    for (const [key, spec] of Object.entries(PRICE_SPECS)) {
      expect(spec.plan).toBe(PLANS[key as keyof typeof PLANS].plan);
    }
    expect(Object.keys(PRODUCT_SPECS).sort()).toEqual(['essentiel', 'revendeur']);
  });

  it('changes nothing the second time', async () => {
    const account = fakeAccount();
    await run(account);

    const { summary } = await run(account);

    expect(account.calls.productCreates).toHaveLength(2);
    expect(account.calls.priceCreates).toHaveLength(3);
    expect(account.calls.portalCreates).toHaveLength(1);
    expect(account.calls.portalUpdates).toHaveLength(1);
    expect(summary.products.map((product) => product.outcome)).toEqual(['found', 'found']);
    expect(outcomes(summary)).toEqual({
      essentiel_monthly: 'found',
      essentiel_yearly: 'found',
      revendeur_monthly: 'found',
    });
    expect(summary.portal.outcome).toBe('updated');
    expect(account.state.products).toHaveLength(2);
    expect(account.state.prices).toHaveLength(3);
    expect(account.state.portals).toHaveLength(1);
  });

  it("reuses active products that have the plans' names, even among many", async () => {
    const account = fakeAccount();
    for (const name of ['A', 'B', 'C', 'D']) {
      account.state.products.push({ id: `prod_${name}`, name, metadata: {} });
    }
    account.state.products.push({ id: 'prod_ess', name: 'Fripon Essentiel', metadata: {} });

    const { summary } = await run(account);

    expect(summary.products).toEqual([
      { plan: 'essentiel', id: 'prod_ess', outcome: 'found' },
      { plan: 'revendeur', id: expect.any(String), outcome: 'created' },
    ]);
    expect(account.calls.productCreates).toHaveLength(1);
    expect(account.calls.priceCreates[0]).toMatchObject({ product: 'prod_ess' });
    expect(account.calls.priceCreates[2]).toMatchObject({
      product: productOf(summary, 'revendeur'),
    });
  });

  it('prefers the product its own tag names over one that only shares the name', async () => {
    const account = fakeAccount();
    account.state.products.push({ id: 'prod_same_name', name: 'Fripon Revendeur', metadata: {} });
    account.state.products.push({
      id: 'prod_tagged',
      name: 'Fripon Revendeur (renamed)',
      metadata: { fripon: 'cloud', plan: 'revendeur' },
    });

    const { summary } = await run(account);

    expect(productOf(summary, 'revendeur')).toBe('prod_tagged');
  });

  it('leaves an old single « Fripon » product alone, and moves the prices to the new products', async () => {
    const account = fakeAccount();
    account.state.products.push({ id: 'prod_old', name: 'Fripon', metadata: { fripon: 'cloud' } });
    for (const [key, spec] of Object.entries(PRICE_SPECS)) {
      account.state.prices.push({
        id: `price_old_${key}`,
        active: true,
        lookup_key: key,
        unit_amount: spec.amount,
        currency: 'eur',
        tax_behavior: 'inclusive',
        recurring: { interval: spec.interval, interval_count: 1 },
        product: 'prod_old',
      });
    }

    const { summary } = await run(account);

    expect(summary.products.map((product) => product.outcome)).toEqual(['created', 'created']);
    expect(outcomes(summary)).toEqual({
      essentiel_monthly: 'replaced',
      essentiel_yearly: 'replaced',
      revendeur_monthly: 'replaced',
    });
    expect(account.state.products.find((product) => product.id === 'prod_old')).toEqual({
      id: 'prod_old',
      name: 'Fripon',
      metadata: { fripon: 'cloud' },
    });
    // The prices now live on the new products, and the old ones keep serving their subscribers.
    const held = (key: string) =>
      account.state.prices.find((price) => price.lookup_key === key) as StoredPrice;
    expect(held('essentiel_yearly').product).toBe(productOf(summary, 'essentiel'));
    expect(held('revendeur_monthly').product).toBe(productOf(summary, 'revendeur'));
  });

  it('moves a lookup key to a new price when the amount differs, and keeps the others', async () => {
    const account = fakeAccount();
    await run(account);
    const old = account.state.prices.find(
      (price) => price.lookup_key === 'essentiel_monthly',
    ) as StoredPrice;
    old.unit_amount = 199;

    const { summary } = await run(account);

    expect(outcomes(summary)).toEqual({
      essentiel_monthly: 'replaced',
      essentiel_yearly: 'found',
      revendeur_monthly: 'found',
    });
    expect(summary.prices.find((price) => price.lookupKey === 'essentiel_monthly')?.replaced).toBe(
      old.id,
    );
    expect(account.calls.priceCreates).toHaveLength(4);
    expect(account.calls.priceCreates[3]).toMatchObject({
      lookup_key: 'essentiel_monthly',
      unit_amount: 299,
      transfer_lookup_key: true,
    });
    expect(old.lookup_key).toBeNull();
    expect(
      account.state.prices.filter((price) => price.lookup_key === 'essentiel_monthly'),
    ).toHaveLength(1);
  });

  it.each([
    ['archived', (price: StoredPrice) => (price.active = false)],
    ['without tax behavior', (price: StoredPrice) => (price.tax_behavior = 'unspecified')],
    ['in another currency', (price: StoredPrice) => (price.currency = 'usd')],
    [
      'on another interval',
      (price: StoredPrice) => (price.recurring = { interval: 'week', interval_count: 1 }),
    ],
    ['on another product', (price: StoredPrice) => (price.product = 'prod_other')],
  ])('replaces a price that is %s', async (_name, change) => {
    const account = fakeAccount();
    await run(account);
    change(
      account.state.prices.find((price) => price.lookup_key === 'revendeur_monthly') as StoredPrice,
    );

    const { summary } = await run(account);

    expect(outcomes(summary).revendeur_monthly).toBe('replaced');
    expect(account.calls.priceCreates.at(-1)).toMatchObject({
      lookup_key: 'revendeur_monthly',
      transfer_lookup_key: true,
    });
  });

  it('configures the portal: cancel at period end, card, invoices, switching between the three prices', async () => {
    const account = fakeAccount();

    const { summary } = await run(account);

    const features = account.calls.portalCreates[0]?.features;
    const priceOf = (key: string) =>
      summary.prices.find((price) => price.lookupKey === key)?.id as string;
    expect(features).toMatchObject({
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        // Each product with its own prices: the plans' names show in the portal.
        products: [
          {
            product: productOf(summary, 'essentiel'),
            prices: [priceOf('essentiel_monthly'), priceOf('essentiel_yearly')],
          },
          { product: productOf(summary, 'revendeur'), prices: [priceOf('revendeur_monthly')] },
        ],
      },
    });
  });

  it('points the portal at a replaced price when it is updated', async () => {
    const account = fakeAccount();
    await run(account);
    (account.state.prices[0] as StoredPrice).unit_amount = 1;

    const { summary } = await run(account);

    const updated = account.calls.portalUpdates[0]?.params.features?.subscription_update
      ?.products as Array<{ product: string; prices: string[] }>;
    expect(updated.flatMap((entry) => entry.prices).sort()).toEqual(
      summary.prices.map((price) => price.id).sort(),
    );
    expect(updated.flatMap((entry) => entry.prices)).not.toContain(account.state.prices[0]?.id);
    expect(updated.map((entry) => entry.product)).toEqual([
      productOf(summary, 'essentiel'),
      productOf(summary, 'revendeur'),
    ]);
  });

  describe('webhook endpoint', () => {
    const URL = 'https://cloud.fripon.test/v1/stripe/webhook';

    it('is not touched without --webhook', async () => {
      const account = fakeAccount();
      await run(account);
      expect(account.state.webhooks).toEqual([]);
    });

    it('is created for the four events handled, pinned to the SDK API version, and its secret is printed once', async () => {
      const account = fakeAccount();

      const { summary, lines } = await run(account, URL);

      expect(account.calls.webhookCreates).toEqual([
        {
          url: URL,
          enabled_events: [...WEBHOOK_EVENTS],
          description: 'Fripon Cloud',
          api_version: STRIPE_API_VERSION,
        },
      ]);
      expect(WEBHOOK_EVENTS).toHaveLength(4);
      expect(summary.webhook).toMatchObject({ outcome: 'created', secret: 'whsec_created_once' });
      expect(lines.filter((line) => line.includes('whsec_created_once'))).toHaveLength(1);

      const again = await run(account, URL);
      expect(account.calls.webhookCreates).toHaveLength(1);
      expect(again.summary.webhook).toMatchObject({ outcome: 'found', secret: null });
      expect(again.lines.join('\n')).not.toContain('whsec_');
    });

    it('gets the missing events added to an endpoint that exists', async () => {
      const account = fakeAccount();
      account.state.webhooks.push({
        id: 'we_old',
        url: URL,
        enabled_events: ['checkout.session.completed'],
      });

      const { summary } = await run(account, URL);

      expect(summary.webhook).toMatchObject({ id: 'we_old', outcome: 'updated', secret: null });
      expect(account.calls.webhookCreates).toHaveLength(0);
      expect(account.state.webhooks[0]?.enabled_events).toEqual([...WEBHOOK_EVENTS]);
    });
  });
});

describe('parseArgs', () => {
  it('reads nothing, --live and --webhook in both spellings', () => {
    expect(parseArgs([])).toEqual({ webhookUrl: null, live: false });
    expect(parseArgs(['--live'])).toEqual({ webhookUrl: null, live: true });
    expect(parseArgs(['--webhook', 'https://a.test/hook'])).toMatchObject({
      webhookUrl: 'https://a.test/hook',
    });
    expect(parseArgs(['--webhook=https://a.test/hook', '--live'])).toEqual({
      webhookUrl: 'https://a.test/hook',
      live: true,
    });
  });

  it.each([
    [['--webhook']],
    [['--webhook=']],
    [['--webhook', 'not a url']],
    [['--webhook', 'http://a.test/hook']],
    [['--wat']],
    [['https://a.test']],
  ])('refuses %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe('checkedKey', () => {
  it('accepts a test key and a restricted test key', () => {
    expect(checkedKey(' sk_test_abc ', false)).toBe('sk_test_abc');
    expect(checkedKey('rk_test_abc', false)).toBe('rk_test_abc');
  });

  it('refuses a live key unless --live is passed', () => {
    expect(() => checkedKey('sk_live_abc', false)).toThrow(/--live/);
    expect(() => checkedKey('rk_live_abc', false)).toThrow(/--live/);
    expect(checkedKey('sk_live_abc', true)).toBe('sk_live_abc');
  });

  it.each([undefined, '', '   ', 'pk_test_abc', 'whsec_abc', 'sk_abc'])('refuses %j', (key) => {
    expect(() => checkedKey(key, true)).toThrow();
  });
});
