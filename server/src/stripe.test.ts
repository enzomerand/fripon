import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import {
  PRICE_CACHE_MS,
  STRIPE_API_VERSION,
  createPriceResolver,
  idOf,
  realStripe,
  type StripeApi,
} from './stripe';

describe('realStripe', () => {
  it('pins the API version the SDK was written against', () => {
    const client = realStripe('sk_test_abc') as unknown as Stripe;
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
    expect(client.getApiField('version')).toBe(Stripe.API_VERSION);
  });

  it('builds a client without a key, which only checks signatures', async () => {
    const client = realStripe('');
    const secret = 'whsec_test_secret';
    const payload = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'invoice.paid',
      data: { object: {} },
    });
    const header = new Stripe('sk_test_signer').webhooks.generateTestHeaderString({
      payload,
      secret,
    });

    await expect(
      client.webhooks.constructEventAsync(payload, header, secret),
    ).resolves.toMatchObject({
      id: 'evt_1',
      type: 'invoice.paid',
    });
    await expect(
      client.webhooks.constructEventAsync(payload, header, 'whsec_other'),
    ).rejects.toThrow();
  });
});

describe('idOf', () => {
  it('reads an id or an expanded object, and nothing else', () => {
    expect(idOf('cus_1')).toBe('cus_1');
    expect(idOf({ id: 'cus_2', object: 'customer' })).toBe('cus_2');
    for (const value of ['', null, undefined, 7, {}, { id: 3 }, { id: '' }, []]) {
      expect(idOf(value)).toBeNull();
    }
  });
});

describe('createPriceResolver', () => {
  function fakePrices() {
    const lookups: string[][] = [];
    let active = new Set(['essentiel_monthly', 'revendeur_monthly']);
    const stripe: Pick<StripeApi, 'prices'> = {
      prices: {
        async list(params) {
          lookups.push(params.lookup_keys);
          return {
            data: params.lookup_keys
              .filter((key) => active.has(key))
              .map((key) => ({ id: `price_${key}`, lookup_key: key })),
          };
        },
      },
    };
    return { stripe, lookups, setActive: (keys: string[]) => (active = new Set(keys)) };
  }

  it('asks Stripe for the active price of a lookup key', async () => {
    const { stripe, lookups } = fakePrices();
    const resolve = createPriceResolver(stripe, () => 0);

    expect(await resolve('essentiel_monthly')).toBe('price_essentiel_monthly');
    expect(lookups).toEqual([['essentiel_monthly']]);
  });

  it('remembers each key for ten minutes on its own', async () => {
    const { stripe, lookups } = fakePrices();
    let now = 1_000;
    const resolve = createPriceResolver(stripe, () => now);

    await resolve('essentiel_monthly');
    now += PRICE_CACHE_MS - 1;
    await resolve('essentiel_monthly');
    await resolve('revendeur_monthly');
    expect(lookups).toEqual([['essentiel_monthly'], ['revendeur_monthly']]);

    now += 1;
    await resolve('essentiel_monthly');
    expect(lookups).toEqual([['essentiel_monthly'], ['revendeur_monthly'], ['essentiel_monthly']]);
  });

  it('throws for a key with no active price, and asks again next time', async () => {
    const { stripe, lookups, setActive } = fakePrices();
    const resolve = createPriceResolver(stripe, () => 0);

    await expect(resolve('essentiel_yearly')).rejects.toThrow(/essentiel_yearly/);
    setActive(['essentiel_yearly']);
    expect(await resolve('essentiel_yearly')).toBe('price_essentiel_yearly');
    expect(lookups).toHaveLength(2);
  });

  it('ignores a price Stripe answers with another lookup key', async () => {
    const stripe: Pick<StripeApi, 'prices'> = {
      prices: { list: async () => ({ data: [{ id: 'price_other', lookup_key: 'other' }] }) },
    };
    await expect(createPriceResolver(stripe, () => 0)('essentiel_monthly')).rejects.toThrow();
  });
});
