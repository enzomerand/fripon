import type { Alert } from './alerts';
import { getAccount, type Account, type Db } from './db';
import { ACTIVE_STATUSES, planOfPrice } from './plans';
import {
  SUBSCRIPTION_EXPAND,
  idOf,
  isMissing,
  type StripeApi,
  type StripeEvent,
  type StripeSubscription,
} from './stripe';

/**
 * Turns what Stripe says into writes on `accounts`: from the webhook's events, from the checkout
 * guard that found a live subscription the row did not know, from the lazy resync of an account
 * whose row looks stale, and from `npm run stripe:resync`. Every path ends in the same step,
 * "read the subscription again from Stripe and store it", so a late, repeated or out-of-order
 * event can only ever write what Stripe says right now.
 */

/** A stale-looking account is read again from Stripe at most this often. */
export const REFRESH_EVERY_MS = 10 * 60 * 1000;
/** A request waits this long for that read; past it, it answers from what is stored (the read goes on). */
export const REFRESH_WAIT_MS = 8_000;

/** Whether a stored subscription status is one Stripe bills on (`ACTIVE_STATUSES`). */
export const isActive = (status: string | null): boolean =>
  status !== null && ACTIVE_STATUSES.includes(status);

/** What `resyncAll` did, in numbers: nothing about any account. */
export interface ResyncSummary {
  accounts: number;
  synced: number;
  /** The subscription no longer exists at Stripe: the account's subscription columns were cleared. */
  cleared: number;
  failed: number;
}

export interface SubscriptionSync {
  /** Turns one verified webhook event into writes. Throws when Stripe could not be read (the 500 makes it retry). */
  handle(event: StripeEvent): Promise<void>;
  /** Reads a subscription again from Stripe and stores it on the account it belongs to. */
  syncSubscription(subscriptionId: string): Promise<void>;
  /**
   * The account as it is now. When its row looks stale (it has a subscription whose period is
   * over, or whose status is not an active one, or no plan) the subscription is read again from
   * Stripe first, at most once per `REFRESH_EVERY_MS` per account. Never throws.
   */
  refresh(account: Account): Promise<Account>;
  /** Reads again the subscription of every account that has one, one after the other. */
  resyncAll(): Promise<ResyncSummary>;
}

export interface SubscriptionSyncDeps {
  stripe: StripeApi;
  db: Db;
  now: () => number;
  alert: Alert;
}

/** How a read of one subscription ended. */
type SyncOutcome = 'synced' | 'missing' | 'ignored';

export function createSubscriptionSync({
  stripe,
  db,
  now,
  alert,
}: SubscriptionSyncDeps): SubscriptionSync {
  const findByCustomer = db.prepare('SELECT * FROM accounts WHERE stripe_customer_id = ?');
  const lastRefresh = new Map<string, number>();
  // The reads of one subscription run one after the other: two events at once must not write a
  // state older than the one the other read.
  const chains = new Map<string, Promise<unknown>>();

  /** Runs `task` after every task already queued for this subscription. */
  function inOrder<T>(subscriptionId: string, task: () => Promise<T>): Promise<T> {
    const run = (chains.get(subscriptionId) ?? Promise.resolve()).then(() => task());
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(subscriptionId, tail);
    void tail.then(() => {
      if (chains.get(subscriptionId) === tail) chains.delete(subscriptionId);
    });
    return run;
  }

  /** Remembers which Stripe customer an account is, once. */
  function linkCustomer(accountId: string, customerId: string): void {
    try {
      db.prepare(
        'UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL',
      ).run(customerId, accountId);
    } catch (error) {
      // The column is unique: this customer already belongs to another account.
      console.error(
        `[stripe] customer ${customerId} could not be linked to account ${accountId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  function accountOf(subscription: StripeSubscription): Account | null {
    const fromMetadata = subscription.metadata.account_id;
    const direct = fromMetadata ? getAccount(db, fromMetadata) : null;
    if (direct) return direct;
    const customerId = idOf(subscription.customer);
    if (customerId === null) return null;
    return (findByCustomer.get(customerId) as Account | undefined) ?? null;
  }

  /**
   * Called when `incoming` is live and the account's stored subscription is another one that its
   * row says is live too. Asks Stripe whether the stored one really is, and if so which of the two
   * is the most recent (the account keeps that one), logs an error line naming both and tells the
   * owner. True when the stored one stays, so the incoming one must not be written.
   */
  async function keepsStored(account: Account, incoming: StripeSubscription): Promise<boolean> {
    const storedId = account.subscription_id as string;
    let stored: StripeSubscription;
    try {
      stored = await stripe.subscriptions.retrieve(storedId, { expand: SUBSCRIPTION_EXPAND });
    } catch (error) {
      // Stripe no longer knows it: nothing is charged for it, the new one simply replaces it.
      if (isMissing(error)) return false;
      throw error;
    }
    // The row was stale: the stored subscription ended and the event is still on its way.
    if (!isActive(stored.status)) return false;

    const incomingIsNewer = incoming.created > stored.created;
    const [kept, other] = incomingIsNewer ? [incoming, stored] : [stored, incoming];
    const line =
      `DOUBLE SUBSCRIPTION: account ${account.id} has two live subscriptions, ` +
      `${kept.id} (kept, the most recent) and ${other.id}. Cancel or refund one in the Stripe Dashboard: ` +
      'nothing was cancelled automatically.';
    console.error(`[stripe] ${line}`);
    alert('double-subscription', line);
    return !incomingIsNewer;
  }

  /** The account has no subscription any more at Stripe: what it said about one goes. */
  function clearSubscription(accountId: string, subscriptionId: string): void {
    db.prepare(
      `UPDATE accounts SET subscription_id = NULL, plan = NULL, subscription_status = NULL,
         period_end = NULL
       WHERE id = ? AND subscription_id = ?`,
    ).run(accountId, subscriptionId);
  }

  /**
   * Reads the subscription again from Stripe and stores what it says now. `forAccount` is the
   * account whose own stored subscription is being read again (a resync): a subscription Stripe no
   * longer knows then clears its columns, where a webhook event about one is simply ignored.
   */
  async function syncOne(subscriptionId: string, forAccount?: Account): Promise<SyncOutcome> {
    let subscription: StripeSubscription;
    try {
      subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: SUBSCRIPTION_EXPAND,
      });
    } catch (error) {
      // Stripe will never know it again: a retry would only repeat this.
      if (!isMissing(error)) throw error;
      if (forAccount) {
        clearSubscription(forAccount.id, subscriptionId);
        console.error(`[stripe] subscription ${subscriptionId} does not exist, account cleared`);
        return 'missing';
      }
      console.error(`[stripe] subscription ${subscriptionId} does not exist, event ignored`);
      return 'ignored';
    }

    const account = forAccount ? getAccount(db, forAccount.id) : accountOf(subscription);
    if (!account) {
      console.error(
        `[stripe] subscription ${subscription.id} belongs to no account, event ignored`,
      );
      return 'ignored';
    }

    if (
      account.subscription_id !== null &&
      account.subscription_id !== subscription.id &&
      isActive(account.subscription_status)
    ) {
      // A late event about an older subscription must not wipe the one the account pays for now.
      if (!isActive(subscription.status)) return 'ignored';
      // A second live subscription: the account is being charged twice. Keep the most recent one
      // and tell the owner, who decides what to cancel or refund (no money moves from here).
      if (await keepsStored(account, subscription)) return 'ignored';
    }

    const item = subscription.items.data[0];
    const plan = item === undefined ? null : planOfPrice(item.price);
    if (plan === null) {
      console.error(
        `[stripe] subscription ${subscription.id} has a price Fripon does not sell ` +
          `(lookup key ${item?.price.lookup_key ?? 'none'}): no plan stored`,
      );
    }
    const customerId = idOf(subscription.customer);
    if (customerId !== null) linkCustomer(account.id, customerId);

    const periodEnd = item?.current_period_end ?? subscription.current_period_end;
    db.prepare(
      `UPDATE accounts
       SET subscription_id = @subscriptionId, plan = @plan, subscription_status = @status,
           period_end = @periodEnd
       WHERE id = @id`,
    ).run({
      id: account.id,
      subscriptionId: subscription.id,
      plan,
      status: subscription.status,
      periodEnd: typeof periodEnd === 'number' ? periodEnd * 1000 : null,
    });
    return 'synced';
  }

  /** Checkout is done: the customer is the account's (the session says whose), then the subscription. */
  async function checkoutCompleted(session: unknown): Promise<void> {
    if (typeof session !== 'object' || session === null) return;
    const fields = session as Record<string, unknown>;
    const accountId = fields.client_reference_id;
    const customerId = idOf(fields.customer);
    if (typeof accountId === 'string' && customerId !== null) linkCustomer(accountId, customerId);

    const subscriptionId = idOf(fields.subscription);
    if (subscriptionId !== null) await sync.syncSubscription(subscriptionId);
  }

  /** A customer disputed a charge: the owner has days to answer it in the Dashboard, so he is told. */
  function disputeOpened(dispute: unknown): void {
    const fields =
      typeof dispute === 'object' && dispute !== null ? (dispute as Record<string, unknown>) : {};
    const detail = (name: string, value: unknown) =>
      typeof value === 'string' || typeof value === 'number' ? ` ${name} ${value}.` : '';
    alert(
      'dispute',
      `A customer disputed a charge.${detail('Dispute', fields.id)}${detail('Charge', fields.charge)}` +
        `${detail('Reason:', fields.reason)} Answer it in the Stripe Dashboard before its deadline. ` +
        'Nothing was cancelled or refunded automatically.',
    );
  }

  /** Whether an account's row looks out of date with Stripe (see `SubscriptionSync.refresh`). */
  function looksStale(account: Account, at: number): boolean {
    if (account.subscription_id === null) return false;
    return (
      (account.period_end !== null && account.period_end <= at) ||
      !isActive(account.subscription_status) ||
      account.plan === null
    );
  }

  const sync: SubscriptionSync = {
    async handle(event) {
      switch (event.type) {
        case 'checkout.session.completed':
          return checkoutCompleted(event.data.object);
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const subscriptionId = idOf(event.data.object);
          if (subscriptionId !== null) await sync.syncSubscription(subscriptionId);
          return;
        }
        case 'charge.dispute.created':
          return disputeOpened(event.data.object);
        default:
          // Not an event this server asked for: acknowledged, nothing to do.
          return;
      }
    },

    async syncSubscription(subscriptionId) {
      await inOrder(subscriptionId, () => syncOne(subscriptionId));
    },

    async refresh(account) {
      const at = now();
      const subscriptionId = account.subscription_id;
      if (subscriptionId === null || !looksStale(account, at)) return account;
      const last = lastRefresh.get(account.id);
      if (last !== undefined && at - last < REFRESH_EVERY_MS) return account;
      // Recorded before the read: a Stripe that is down is not asked again by every request.
      lastRefresh.set(account.id, at);
      if (lastRefresh.size > 10_000) {
        for (const [id, when] of lastRefresh) {
          if (at - when >= REFRESH_EVERY_MS) lastRefresh.delete(id);
        }
      }

      const read = inOrder(subscriptionId, () => syncOne(subscriptionId, account)).then(
        () => undefined,
        (error: unknown) => {
          console.error(
            `[stripe] refresh of account ${account.id} failed:`,
            error instanceof Error ? error.message : error,
          );
        },
      );
      let timer: NodeJS.Timeout | undefined;
      const patience = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REFRESH_WAIT_MS);
        timer.unref();
      });
      try {
        await Promise.race([read, patience]);
      } finally {
        clearTimeout(timer);
      }
      return getAccount(db, account.id) ?? account;
    },

    async resyncAll() {
      const rows = db
        .prepare('SELECT * FROM accounts WHERE subscription_id IS NOT NULL ORDER BY created_at')
        .all() as Account[];
      const summary: ResyncSummary = { accounts: rows.length, synced: 0, cleared: 0, failed: 0 };
      for (const account of rows) {
        const subscriptionId = account.subscription_id as string;
        try {
          const outcome = await inOrder(subscriptionId, () => syncOne(subscriptionId, account));
          if (outcome === 'missing') summary.cleared++;
          else summary.synced++;
        } catch (error) {
          summary.failed++;
          console.error(
            `[stripe] resync of account ${account.id} failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      return summary;
    },
  };
  return sync;
}
