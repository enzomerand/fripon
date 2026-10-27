import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, RouteModule } from '../context';
import { getAccount, type Account, type Db } from '../db';
import { limitBody, readJsonObject } from '../http';
import { ACTIVE_STATUSES, PLANS, planForLookupKey } from '../plans';
import {
  createPriceResolver,
  idOf,
  type StripeApi,
  type StripeEvent,
  type StripeSubscription,
} from '../stripe';

/** What Stripe's webhook may send: its events are bigger than the extension's requests. */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/** Tags the Checkout Sessions of this server in the Stripe Dashboard (name + 8 random letters). */
const INTEGRATION_IDENTIFIER = 'fripon-cloud-qvhtnmzk';

/** What the buyer ticks at Checkout when `STRIPE_REQUIRE_TERMS` is on (digital content, EU rules). */
export const TERMS_MESSAGE =
  "J'accepte que Fripon démarre tout de suite et je renonce à mon droit de rétractation de 14 jours.";

export const DONE_MESSAGE =
  "C'est tout bon ! Ton abonnement Fripon est actif. Tu peux fermer cet onglet et retourner sur Vinted.";
export const CANCEL_MESSAGE = "Paiement annulé. Rien n'a été débité. Tu peux fermer cet onglet.";

/** A tiny static page: no script, no personal data, nothing but the message. */
function messagePage(title: string, message: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 18px/1.5 system-ui, sans-serif; }
main { max-width: 28rem; padding: 2rem 1.5rem; text-align: center; }
h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
p { margin: 0; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${message}</p>
</main>
</body>
</html>
`;
}

/** Nothing may be loaded or framed by these pages, and the inline style is the only allowance. */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

/** A deleted subscription is still readable; one Stripe no longer knows never will be. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'resource_missing'
  );
}

const isActive = (status: string | null): boolean =>
  status !== null && ACTIVE_STATUSES.includes(status);

/**
 * What a customer's subscription must not be for a new Checkout: Stripe has it (or is about to)
 * charging the customer, whatever the local row says (it only moves when a webhook arrives).
 */
const BLOCKS_CHECKOUT: readonly string[] = ['active', 'trialing', 'past_due', 'incomplete'];

/** How many of a customer's subscriptions are read to look for a live one. */
const SUBSCRIPTIONS_READ = 100;

/**
 * Billing: Checkout and the customer portal for the extension, the two pages Stripe sends the
 * buyer back to, and the webhook that keeps `accounts` in step with what Stripe says.
 *
 * The webhook is the only writer of `plan`, `subscription_status` and `period_end`: the browser
 * coming back from Checkout proves nothing. Every event is turned into the same step, "read the
 * subscription again from Stripe and store it", so a late, repeated or out-of-order event can only
 * ever write what Stripe says right now.
 */
export function registerBillingRoutes(stripe: StripeApi): RouteModule {
  return (app, ctx) => {
    const base = ctx.config.publicUrl.replace(/\/+$/, '');
    const priceId = createPriceResolver(stripe, () => ctx.now().getTime());

    /** A failed Stripe call: the client hears "upstream", the log hears why (never a body or an address). */
    function stripeFailed(c: Context<AppEnv>, what: string, error: unknown): Response {
      console.error(`[stripe] ${what} failed:`, error instanceof Error ? error.message : error);
      return c.json({ error: 'upstream' }, 502);
    }

    /** The Stripe customer of an account: the stored one, or a new one stored for next time. */
    async function customerOf(account: Account): Promise<string> {
      if (account.stripe_customer_id !== null) return account.stripe_customer_id;

      // The key makes two requests at once (a double click) share one customer.
      const customer = await stripe.customers.create(
        { email: account.email, metadata: { account_id: account.id } },
        { idempotencyKey: `fripon-customer-${account.id}` },
      );
      const stored = ctx.db
        .prepare(
          'UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL',
        )
        .run(customer.id, account.id);
      if (stored.changes === 1) return customer.id;
      return getAccount(ctx.db, account.id)?.stripe_customer_id ?? customer.id;
    }

    async function portalUrl(customer: string): Promise<string> {
      const portal = ctx.config.stripePortalConfiguration;
      const session = await stripe.billingPortal.sessions.create({
        customer,
        return_url: `${base}/billing/done`,
        locale: 'fr',
        ...(portal !== null && { configuration: portal }),
      });
      return session.url;
    }

    app.post('/v1/billing/checkout', ctx.requireAccount, limitBody, async (c) => {
      const price = (await readJsonObject(c))?.price;
      if (typeof price !== 'string' || !Object.hasOwn(PLANS, price)) {
        return c.json({ error: 'invalid_request' }, 400);
      }

      const account = c.get('account');
      try {
        // One subscription per account: someone who has one changes it in the portal.
        if (isActive(account.subscription_status) && account.stripe_customer_id !== null) {
          return c.json({ url: await portalUrl(account.stripe_customer_id) });
        }
        // The local status is only as fresh as the last webhook: two Checkouts opened before the
        // first one's event arrived would make two paid subscriptions. Stripe is asked instead.
        if (account.stripe_customer_id !== null) {
          const { data } = await stripe.subscriptions.list({
            customer: account.stripe_customer_id,
            limit: SUBSCRIPTIONS_READ,
          });
          if (data.some((subscription) => BLOCKS_CHECKOUT.includes(subscription.status))) {
            return c.json({ url: await portalUrl(account.stripe_customer_id) });
          }
        }

        const customer = await customerOf(account);
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer,
          client_reference_id: account.id,
          line_items: [{ price: await priceId(price), quantity: 1 }],
          subscription_data: { metadata: { account_id: account.id } },
          allow_promotion_codes: true,
          locale: 'fr',
          integration_identifier: INTEGRATION_IDENTIFIER,
          success_url: `${base}/billing/done`,
          cancel_url: `${base}/billing/cancel`,
          ...(ctx.config.stripeRequireTerms && {
            consent_collection: { terms_of_service: 'required' as const },
            custom_text: { terms_of_service_acceptance: { message: TERMS_MESSAGE } },
          }),
        });
        if (!session.url) throw new Error('Stripe answered a Checkout Session without a URL');
        return c.json({ url: session.url });
      } catch (error) {
        return stripeFailed(c, 'checkout', error);
      }
    });

    app.post('/v1/billing/portal', ctx.requireAccount, async (c) => {
      const customer = c.get('account').stripe_customer_id;
      if (customer === null) return c.json({ error: 'no_customer' }, 409);
      try {
        return c.json({ url: await portalUrl(customer) });
      } catch (error) {
        return stripeFailed(c, 'portal', error);
      }
    });

    // Where Stripe sends the buyer back. They say nothing about the payment (the webhook does).
    app.get('/billing/done', (c) => {
      c.header('Content-Security-Policy', PAGE_CSP);
      return c.html(messagePage('Abonnement actif', DONE_MESSAGE));
    });
    app.get('/billing/cancel', (c) => {
      c.header('Content-Security-Policy', PAGE_CSP);
      return c.html(messagePage('Paiement annulé', CANCEL_MESSAGE));
    });

    const sync = createSubscriptionSync(stripe, ctx.db);
    const wasHandled = ctx.db.prepare('SELECT 1 FROM stripe_events WHERE id = ?');
    const recordEvent = ctx.db.prepare(
      'INSERT OR IGNORE INTO stripe_events (id, received_at) VALUES (?, ?)',
    );

    app.post(
      '/v1/stripe/webhook',
      bodyLimit({
        maxSize: WEBHOOK_MAX_BODY_BYTES,
        onError: (c) => c.json({ error: 'payload_too_large' }, 413),
      }),
      async (c) => {
        const signature = c.req.header('stripe-signature');
        if (!signature) return c.json({ error: 'invalid_signature' }, 400);

        // The bytes as they came: the signature covers them, not a parsed or re-encoded copy.
        const raw = new Uint8Array(await c.req.arrayBuffer());
        let event: StripeEvent;
        try {
          event = await stripe.webhooks.constructEventAsync(
            raw,
            signature,
            ctx.config.stripeWebhookSecret,
          );
        } catch {
          return c.json({ error: 'invalid_signature' }, 400);
        }

        // Stripe delivers an event more than once: the second time is a plain 200.
        if (wasHandled.get(event.id) !== undefined) return c.json({ received: true });

        // Handled first, recorded after: a crash in between leaves the event unrecorded, so its
        // redelivery is handled and not ignored. Handling is idempotent (the subscription is read
        // again from Stripe and stored as it is), so two deliveries at once only write it twice.
        // An error is not caught on purpose: the 500 is what makes Stripe retry.
        await sync.handle(event);
        recordEvent.run(event.id, ctx.now().getTime());
        return c.json({ received: true });
      },
    );
  };
}

/** Turns Stripe's events into writes on `accounts`. */
function createSubscriptionSync(stripe: StripeApi, db: Db) {
  const findByCustomer = db.prepare('SELECT * FROM accounts WHERE stripe_customer_id = ?');

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
   * is the most recent (the account keeps that one) and logs an error line naming both. True when
   * the stored one stays, so the incoming one must not be written.
   */
  async function keepsStored(account: Account, incoming: StripeSubscription): Promise<boolean> {
    const storedId = account.subscription_id as string;
    let stored: StripeSubscription;
    try {
      stored = await stripe.subscriptions.retrieve(storedId);
    } catch (error) {
      // Stripe no longer knows it: nothing is charged for it, the new one simply replaces it.
      if (isMissing(error)) return false;
      throw error;
    }
    // The row was stale: the stored subscription ended and the event is still on its way.
    if (!isActive(stored.status)) return false;

    const incomingIsNewer = incoming.created > stored.created;
    const [kept, other] = incomingIsNewer ? [incoming, stored] : [stored, incoming];
    console.error(
      `[stripe] DOUBLE SUBSCRIPTION: account ${account.id} has two live subscriptions, ` +
        `${kept.id} (kept, the most recent) and ${other.id}. Cancel or refund one in the Stripe Dashboard: ` +
        'nothing was cancelled automatically.',
    );
    return !incomingIsNewer;
  }

  /** Reads the subscription again from Stripe and stores what it says now. */
  async function syncSubscription(subscriptionId: string): Promise<void> {
    let subscription: StripeSubscription;
    try {
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (error) {
      // Stripe will never know it again: a retry would only repeat this.
      if (!isMissing(error)) throw error;
      console.error(`[stripe] subscription ${subscriptionId} does not exist, event ignored`);
      return;
    }

    const account = accountOf(subscription);
    if (!account) {
      console.error(
        `[stripe] subscription ${subscription.id} belongs to no account, event ignored`,
      );
      return;
    }

    if (
      account.subscription_id !== null &&
      account.subscription_id !== subscription.id &&
      isActive(account.subscription_status)
    ) {
      // A late event about an older subscription must not wipe the one the account pays for now.
      if (!isActive(subscription.status)) return;
      // A second live subscription: the account is being charged twice. Keep the most recent one
      // and tell the owner, who decides what to cancel or refund (no money moves from here).
      if (await keepsStored(account, subscription)) return;
    }

    const item = subscription.items.data[0];
    const lookupKey = item?.price.lookup_key ?? null;
    const plan = lookupKey === null ? null : planForLookupKey(lookupKey);
    if (plan === null) {
      console.error(
        `[stripe] subscription ${subscription.id} has a price Fripon does not sell ` +
          `(lookup key ${lookupKey ?? 'none'}): no plan stored`,
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
  }

  /** Checkout is done: the customer is the account's (the session says whose), then the subscription. */
  async function checkoutCompleted(session: unknown): Promise<void> {
    if (typeof session !== 'object' || session === null) return;
    const fields = session as Record<string, unknown>;
    const accountId = fields.client_reference_id;
    const customerId = idOf(fields.customer);
    if (typeof accountId === 'string' && customerId !== null) linkCustomer(accountId, customerId);

    const subscriptionId = idOf(fields.subscription);
    if (subscriptionId !== null) await syncSubscription(subscriptionId);
  }

  return {
    async handle(event: StripeEvent): Promise<void> {
      switch (event.type) {
        case 'checkout.session.completed':
          return checkoutCompleted(event.data.object);
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const subscriptionId = idOf(event.data.object);
          if (subscriptionId !== null) await syncSubscription(subscriptionId);
          return;
        }
        default:
          // Not an event this server asked for: acknowledged, nothing to do.
          return;
      }
    },
  };
}
