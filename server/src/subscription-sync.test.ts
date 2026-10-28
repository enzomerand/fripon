import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccount, openDb, type Account, type Db } from './db';
import { SUBSCRIPTION_EXPAND, type StripeApi, type StripeSubscription } from './stripe';
import {
  REFRESH_EVERY_MS,
  REFRESH_WAIT_MS,
  createSubscriptionSync,
  type SubscriptionSync,
} from './subscription-sync';
import {
  CREATED_SECONDS,
  PERIOD_END_SECONDS,
  fakeClock,
  insertAccount,
  subscription,
  type Clock,
} from './test-helpers';

/** What `fakeClock()` starts at: the tables below are built before any test runs. */
const START = Date.parse('2026-10-20T12:00:00Z');

let db: Db;
let clock: Clock;
let known: Map<string, StripeSubscription>;
let retrieve: ReturnType<typeof vi.fn<StripeApi['subscriptions']['retrieve']>>;
let alert: ReturnType<typeof vi.fn<(kind: string, text: string) => void>>;
let sync: SubscriptionSync;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  db = openDb(':memory:');
  clock = fakeClock();
  known = new Map();
  retrieve = vi.fn(async (id: string) => {
    const found = known.get(id);
    if (!found) {
      throw Object.assign(new Error(`No such subscription: ${id}`), { code: 'resource_missing' });
    }
    return found;
  });
  alert = vi.fn();
  sync = createSubscriptionSync({
    stripe: { subscriptions: { retrieve } } as unknown as StripeApi,
    db,
    now: clock.ms,
    alert,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const row = (id: string) => getAccount(db, id) as Account;

describe('the plan of a subscription', () => {
  it('keeps a subscriber on an old price (its lookup key moved to the new one) on the plan the price says', async () => {
    const buyer = insertAccount(db, { stripe_customer_id: 'cus_1' });
    // The lookup key now belongs to another price: this one has none, only the tag stripe:setup set.
    known.set(
      'sub_1',
      subscription({ price: { lookup_key: null, metadata: { plan: 'revendeur' } } }),
    );

    await sync.syncSubscription('sub_1');

    expect(row(buyer.id)).toMatchObject({
      subscription_id: 'sub_1',
      plan: 'revendeur',
      subscription_status: 'active',
    });
  });

  it("falls back on the product's tag when the price has none (an old price, a product updated by stripe:setup)", async () => {
    const buyer = insertAccount(db, { stripe_customer_id: 'cus_1' });
    known.set(
      'sub_1',
      subscription({
        price: {
          lookup_key: null,
          metadata: {},
          product: { id: 'prod_1', metadata: { plan: 'essentiel' } },
        },
      }),
    );

    await sync.syncSubscription('sub_1');

    expect(row(buyer.id).plan).toBe('essentiel');
  });

  it('reads the price tag before the product tag, and both before the lookup key', async () => {
    const buyer = insertAccount(db, { stripe_customer_id: 'cus_1' });
    known.set(
      'sub_1',
      subscription({
        price: {
          lookup_key: 'essentiel_monthly',
          metadata: { plan: 'revendeur' },
          product: { id: 'prod_1', metadata: { plan: 'essentiel' } },
        },
      }),
    );
    await sync.syncSubscription('sub_1');
    expect(row(buyer.id).plan).toBe('revendeur');

    known.set(
      'sub_1',
      subscription({
        price: {
          lookup_key: 'revendeur_monthly',
          metadata: {},
          product: { id: 'prod_1', metadata: { plan: 'essentiel' } },
        },
      }),
    );
    await sync.syncSubscription('sub_1');
    expect(row(buyer.id).plan).toBe('essentiel');
  });

  it('still reads the lookup key when nothing is tagged, and ignores a tag that is no plan', async () => {
    const buyer = insertAccount(db, { stripe_customer_id: 'cus_1' });
    known.set(
      'sub_1',
      subscription({ price: { lookup_key: 'revendeur_monthly', metadata: { plan: 'gold' } } }),
    );

    await sync.syncSubscription('sub_1');

    expect(row(buyer.id).plan).toBe('revendeur');
  });

  it('stores no plan for a price Fripon does not sell, and says so in the log', async () => {
    const buyer = insertAccount(db, { stripe_customer_id: 'cus_1' });
    known.set('sub_1', subscription({ price: { lookup_key: 'other', metadata: { plan: 'x' } } }));

    await sync.syncSubscription('sub_1');

    expect(row(buyer.id)).toMatchObject({ plan: null, subscription_status: 'active' });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('price Fripon does not sell'),
    );
  });

  it("asks Stripe for the price's product along with the subscription", async () => {
    insertAccount(db, { stripe_customer_id: 'cus_1' });
    known.set('sub_1', subscription());

    await sync.syncSubscription('sub_1');

    expect(retrieve).toHaveBeenCalledWith('sub_1', { expand: SUBSCRIPTION_EXPAND });
    expect(SUBSCRIPTION_EXPAND).toEqual(['items.data.price.product']);
  });
});

describe('the subscriptions of one id are read one after the other', () => {
  it('stores the state of the LAST read, whatever the order the answers come back in', async () => {
    const buyer = insertAccount(db, { stripe_customer_id: 'cus_1' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    // The first read is slow and still says "active"; the second (later) one says "canceled".
    retrieve.mockImplementation(async () => {
      const mine = ++reads;
      if (mine === 1) await gate;
      return subscription({ status: mine === 1 ? 'active' : 'canceled' });
    });

    const first = sync.syncSubscription('sub_1');
    const second = sync.syncSubscription('sub_1');
    await vi.waitFor(() => expect(reads).toBe(1));
    // The second read does not start while the first one runs.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toBe(1);
    release();
    await Promise.all([first, second]);

    expect(reads).toBe(2);
    expect(row(buyer.id).subscription_status).toBe('canceled');
  });

  it('does not make different subscriptions wait for each other', async () => {
    insertAccount(db, { stripe_customer_id: 'cus_1' });
    insertAccount(db, { stripe_customer_id: 'cus_2' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    retrieve.mockImplementation(async (id) => {
      if (id === 'sub_slow') await gate;
      return subscription({ id, customer: id === 'sub_slow' ? 'cus_1' : 'cus_2' });
    });

    const slow = sync.syncSubscription('sub_slow');
    await sync.syncSubscription('sub_fast');
    release();
    await slow;

    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it('goes on after a read that failed', async () => {
    const buyer = insertAccount(db, { stripe_customer_id: 'cus_1' });
    retrieve.mockRejectedValueOnce(new Error('Stripe is down'));
    known.set('sub_1', subscription());

    const failed = sync.syncSubscription('sub_1');
    const next = sync.syncSubscription('sub_1');

    await expect(failed).rejects.toThrow('Stripe is down');
    await next;
    expect(row(buyer.id).subscription_status).toBe('active');
  });
});

describe('refresh: the lazy resync of an account that looks stale', () => {
  const stale = (overrides: Partial<Account> = {}) =>
    insertAccount(db, {
      stripe_customer_id: 'cus_1',
      subscription_id: 'sub_1',
      plan: 'essentiel',
      subscription_status: 'active',
      period_end: clock.ms() - 1000,
      ...overrides,
    });

  it.each([
    ['its period is over', {}],
    [
      'its status is not an active one',
      { subscription_status: 'canceled', period_end: START + 1e9 },
    ],
    ['its plan is unknown', { plan: null, period_end: START + 1e9 }],
  ] as const)(
    'reads the subscription again when %s, and answers the fresh state',
    async (_why, patch) => {
      const buyer = stale(patch);
      known.set('sub_1', subscription({ status: 'active' }));

      const fresh = await sync.refresh(row(buyer.id));

      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(fresh).toMatchObject({
        plan: 'essentiel',
        subscription_status: 'active',
        period_end: PERIOD_END_SECONDS * 1000,
      });
      expect(row(buyer.id)).toEqual(fresh);
    },
  );

  it.each([
    [
      'no subscription at all',
      { subscription_id: null, plan: null, subscription_status: null, period_end: null },
    ],
    ['an active subscription inside its period', { period_end: START + 86_400_000 }],
    ['an active subscription with no period known yet', { period_end: null }],
  ] as const)('does not call Stripe for %s', async (_what, patch) => {
    const buyer = stale(patch);
    const account = row(buyer.id);

    expect(await sync.refresh(account)).toBe(account);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('asks at most once every 10 minutes per account, and again after them', async () => {
    const buyer = stale();
    const other = stale({
      email: 'other@example.com',
      stripe_customer_id: 'cus_2',
      subscription_id: 'sub_2',
    });
    // Stripe still says it ended: the row stays stale.
    known.set('sub_1', subscription({ status: 'canceled' }));
    known.set('sub_2', subscription({ id: 'sub_2', status: 'canceled', customer: 'cus_2' }));

    await sync.refresh(row(buyer.id));
    await sync.refresh(row(buyer.id));
    clock.advance(REFRESH_EVERY_MS - 1);
    await sync.refresh(row(buyer.id));
    expect(retrieve).toHaveBeenCalledTimes(1);

    // Another account has its own ten minutes.
    await sync.refresh(row(other.id));
    expect(retrieve).toHaveBeenCalledTimes(2);

    clock.advance(1);
    await sync.refresh(row(buyer.id));
    expect(retrieve).toHaveBeenCalledTimes(3);
  });

  it('shares one read between requests that arrive at once', async () => {
    const buyer = stale();
    known.set('sub_1', subscription());

    await Promise.all([1, 2, 3].map(() => sync.refresh(row(buyer.id))));

    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('answers the stored account when Stripe cannot be read, logs it, and does not ask again for 10 minutes', async () => {
    const buyer = stale();
    retrieve.mockRejectedValue(new Error('Stripe is down'));

    const answer = await sync.refresh(row(buyer.id));
    await sync.refresh(row(buyer.id));

    expect(answer).toEqual(row(buyer.id));
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`refresh of account ${buyer.id} failed`),
      'Stripe is down',
    );
  });

  it('clears the subscription of an account whose subscription Stripe does not know any more', async () => {
    const buyer = stale();

    const answer = await sync.refresh(row(buyer.id));

    expect(answer).toMatchObject({
      subscription_id: null,
      plan: null,
      subscription_status: null,
      period_end: null,
      // The customer is not touched: only what the subscription said.
      stripe_customer_id: 'cus_1',
    });
  });

  it('does not wait more than 8 seconds for Stripe: it answers from what is stored, the read goes on', async () => {
    vi.useFakeTimers();
    const buyer = stale();
    let finish!: () => void;
    retrieve.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve(subscription()))),
    );

    const answer = sync.refresh(row(buyer.id));
    await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS);
    expect(await answer).toEqual(row(buyer.id));
    expect(row(buyer.id).period_end).toBe(clock.ms() - 1000);

    // The read was not dropped: when Stripe answers, the row is updated.
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(row(buyer.id).period_end).toBe(PERIOD_END_SECONDS * 1000);
  });
});

describe('resyncAll', () => {
  it('reads again the subscription of every account that has one, and counts', async () => {
    const renewed = insertAccount(db, {
      stripe_customer_id: 'cus_1',
      subscription_id: 'sub_1',
      plan: 'essentiel',
      subscription_status: 'past_due',
      period_end: 5,
    });
    const gone = insertAccount(db, {
      stripe_customer_id: 'cus_2',
      subscription_id: 'sub_gone',
      plan: 'essentiel',
      subscription_status: 'active',
    });
    const down = insertAccount(db, {
      stripe_customer_id: 'cus_3',
      subscription_id: 'sub_down',
      plan: 'essentiel',
      subscription_status: 'active',
    });
    const none = insertAccount(db);
    known.set('sub_1', subscription());
    retrieve.mockImplementation(async (id) => {
      if (id === 'sub_down') throw new Error('Stripe is down');
      const found = known.get(id);
      if (!found)
        throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
      return found;
    });

    const summary = await sync.resyncAll();

    expect(summary).toEqual({ accounts: 3, synced: 1, cleared: 1, failed: 1 });
    expect(row(renewed.id)).toMatchObject({
      subscription_status: 'active',
      period_end: PERIOD_END_SECONDS * 1000,
    });
    expect(row(gone.id)).toMatchObject({ subscription_id: null, plan: null });
    // A failure leaves the row as it was.
    expect(row(down.id)).toMatchObject({
      subscription_id: 'sub_down',
      subscription_status: 'active',
    });
    expect(row(none.id)).toMatchObject({ subscription_id: null });
    expect(retrieve).toHaveBeenCalledTimes(3);
  });

  it('puts no address, id or key in what it logs for a failure beyond the account id and the reason', async () => {
    insertAccount(db, {
      email: 'private@example.com',
      subscription_id: 'sub_down',
      stripe_customer_id: 'cus_3',
    });
    retrieve.mockRejectedValue(new Error('Stripe is down'));

    await sync.resyncAll();

    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'private@example.com',
    );
  });

  it('is a plain zero on an empty database', async () => {
    expect(await sync.resyncAll()).toEqual({ accounts: 0, synced: 0, cleared: 0, failed: 0 });
  });
});

describe('what the owner is told', () => {
  it('a second live subscription on one account is a DOUBLE SUBSCRIPTION alert, naming both, and nothing is cancelled', async () => {
    const buyer = insertAccount(db, {
      stripe_customer_id: 'cus_1',
      subscription_id: 'sub_old',
      plan: 'essentiel',
      subscription_status: 'active',
    });
    known.set('sub_old', subscription({ id: 'sub_old', created: CREATED_SECONDS }));
    known.set('sub_new', subscription({ id: 'sub_new', created: CREATED_SECONDS + 100 }));

    await sync.syncSubscription('sub_new');

    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      'double-subscription',
      expect.stringContaining('DOUBLE SUBSCRIPTION'),
    );
    const text = alert.mock.calls[0]?.[1] ?? '';
    expect(text).toContain('sub_old');
    expect(text).toContain('sub_new');
    expect(text).toContain('nothing was cancelled automatically');
    expect(row(buyer.id).subscription_id).toBe('sub_new');
  });

  it('a dispute is an alert with its ids and the reason, and changes nothing else', async () => {
    const buyer = insertAccount(db, {
      stripe_customer_id: 'cus_1',
      subscription_id: 'sub_1',
      plan: 'essentiel',
      subscription_status: 'active',
    });
    const before = row(buyer.id);

    await sync.handle({
      id: 'evt_d',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', charge: 'ch_1', reason: 'fraudulent', amount: 299 } },
    });

    expect(alert).toHaveBeenCalledTimes(1);
    const [kind, text] = alert.mock.calls[0] ?? [];
    expect(kind).toBe('dispute');
    expect(text).toContain('dp_1');
    expect(text).toContain('ch_1');
    expect(text).toContain('fraudulent');
    expect(text).toContain('Nothing was cancelled or refunded automatically');
    expect(retrieve).not.toHaveBeenCalled();
    expect(row(buyer.id)).toEqual(before);
  });

  it('a dispute event with an object that is not one is still an alert', async () => {
    await sync.handle({ id: 'evt_d', type: 'charge.dispute.created', data: { object: null } });
    expect(alert).toHaveBeenCalledWith('dispute', expect.stringContaining('disputed a charge'));
  });
});
