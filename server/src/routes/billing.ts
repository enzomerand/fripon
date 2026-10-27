import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, RouteModule } from '../context';
import { getAccount, type Account } from '../db';
import { limitBody, readJsonObject } from '../http';
import { ACTIVE_STATUSES, PLANS } from '../plans';
import {
  createPriceResolver,
  isCustomerMissing,
  isMissing,
  type StripeApi,
  type StripeEvent,
  type StripeSubscription,
} from '../stripe';
import { createSubscriptionSync, isActive } from '../subscription-sync';

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

/** How many of a customer's subscriptions are read to look for a live one. */
const SUBSCRIPTIONS_READ = 100;

/** How many of a customer's open Checkout Sessions are read per page (all pages are read). */
const OPEN_SESSIONS_PAGE = 100;

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
    const sync = createSubscriptionSync({
      stripe,
      db: ctx.db,
      now: () => ctx.now().getTime(),
      alert: ctx.alert,
    });

    /** A failed Stripe call: the client hears "upstream", the log hears why (never a body or an address). */
    function stripeFailed(c: Context<AppEnv>, what: string, error: unknown): Response {
      console.error(`[stripe] ${what} failed:`, error instanceof Error ? error.message : error);
      return c.json({ error: 'upstream' }, 502);
    }

    /**
     * The Stripe customer of an account: the stored one, or a new one stored for next time.
     * `replaced` is the customer this one takes the place of (it does not exist at Stripe any more):
     * it is part of the idempotency key, or Stripe would hand back the answer it gave for the
     * first customer of the account.
     */
    async function customerOf(account: Account, replaced: string | null): Promise<string> {
      if (account.stripe_customer_id !== null) return account.stripe_customer_id;

      // The key makes two requests at once (a double click) share one customer.
      const customer = await stripe.customers.create(
        { email: account.email, metadata: { account_id: account.id } },
        {
          idempotencyKey:
            replaced === null
              ? `fripon-customer-${account.id}`
              : `fripon-customer-${account.id}-after-${replaced}`,
        },
      );
      const stored = ctx.db
        .prepare(
          'UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL',
        )
        .run(customer.id, account.id);
      if (stored.changes === 1) return customer.id;
      return getAccount(ctx.db, account.id)?.stripe_customer_id ?? customer.id;
    }

    /**
     * The stored customer does not exist at Stripe (a test customer once the keys are live, a
     * deleted one): everything the account knows about Stripe goes, the next step makes a new
     * customer. Only if the account still holds that very customer.
     */
    function forgetCustomer(account: Account, customerId: string): void {
      console.error(
        `[stripe] customer ${customerId} of account ${account.id} does not exist at Stripe: the account's Stripe data is cleared`,
      );
      ctx.db
        .prepare(
          `UPDATE accounts SET stripe_customer_id = NULL, subscription_id = NULL, plan = NULL,
             subscription_status = NULL, period_end = NULL
           WHERE id = ? AND stripe_customer_id = ?`,
        )
        .run(account.id, customerId);
    }

    /**
     * Runs `step`; if Stripe says the stored customer does not exist, forgets it and runs the step
     * once more for the account without one. `replaced` tells the step which customer it replaces.
     */
    async function withCustomerRecovery<T>(
      account: Account,
      step: (account: Account, replaced: string | null) => Promise<T>,
    ): Promise<T> {
      try {
        return await step(account, null);
      } catch (error) {
        const stale = account.stripe_customer_id;
        if (stale === null || !isCustomerMissing(error)) throw error;
        forgetCustomer(account, stale);
        return step(getAccount(ctx.db, account.id) ?? account, stale);
      }
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

    /** A customer's subscriptions at Stripe, the canceled ones left out. */
    async function subscriptionsOf(customer: string): Promise<StripeSubscription[]> {
      const { data } = await stripe.subscriptions.list({ customer, limit: SUBSCRIPTIONS_READ });
      return data;
    }

    /**
     * Stripe has a live subscription the row does not know (a lost webhook): store it, so the
     * account gets its plan now and not at the next event. A failure only means a later event or
     * resync stores it.
     */
    async function storeLive(live: StripeSubscription): Promise<void> {
      try {
        await sync.syncSubscription(live.id);
      } catch (error) {
        console.error(
          `[stripe] the live subscription ${live.id} could not be stored:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    /**
     * Cancels a subscription read as abandoned (`incomplete`). Reading and cancelling are two
     * calls, so a payment can still land between them: the answer of the cancel says whether the
     * first invoice was paid by then, and if it was the money is taken for a subscription that is
     * gone. Nothing can be refunded from here, so the owner is told, to refund it by hand.
     */
    async function cancelOne(subscriptionId: string): Promise<void> {
      const cancelled = await stripe.subscriptions.cancel(subscriptionId, {
        expand: ['latest_invoice'],
      });
      const invoice = cancelled.latest_invoice;
      if (typeof invoice === 'object' && invoice !== null && invoice.status === 'paid') {
        const line =
          `PAID WHILE CANCELLED: the subscription ${subscriptionId} was paid just as it was cancelled ` +
          'as an abandoned first payment. It is cancelled now, so the customer paid for nothing: ' +
          'refund the payment in the Stripe Dashboard (nothing was refunded automatically).';
        console.error(`[stripe] ${line}`);
        ctx.alert(`paid-while-cancelled:${subscriptionId}`, line);
      }
    }

    /**
     * Ends the abandoned first payments of a customer, so that none can be paid later next to a
     * new Checkout (a second charge) or after the account is gone. Each one is read again right
     * before it is cancelled: the list may be seconds old, and a payment that went through since
     * is a subscription that bills, not an abandoned one, so it is not cancelled (the first such
     * one is returned; the others are still ended). A payment that lands between that read and
     * the cancel cannot be prevented, only noticed (`cancelOne`). One Stripe no longer has is
     * already gone.
     */
    async function cancelAbandoned(
      subscriptions: StripeSubscription[],
    ): Promise<StripeSubscription | null> {
      let paidMeanwhile: StripeSubscription | null = null;
      for (const listed of subscriptions) {
        if (listed.status !== 'incomplete') continue;
        try {
          const current = await stripe.subscriptions.retrieve(listed.id);
          if (ACTIVE_STATUSES.includes(current.status)) paidMeanwhile ??= current;
          else if (current.status === 'incomplete') await cancelOne(listed.id);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      return paidMeanwhile;
    }

    /**
     * The customer has a live subscription and goes to the portal: the abandoned first payments
     * beside it are ended too, or one paid later would make a second subscription. Nothing waits
     * on it (no Checkout is made), so a failure only leaves them for the next time.
     */
    async function cancelAbandonedBesideLive(
      customer: string,
      listed?: StripeSubscription[],
    ): Promise<void> {
      try {
        await cancelAbandoned(listed ?? (await subscriptionsOf(customer)));
      } catch (error) {
        console.error(
          `[stripe] the abandoned payments of ${customer} could not be cancelled:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    /**
     * The subscription of a customer that bills it (`ACTIVE_STATUSES`), wherever it is in the list;
     * only when there is none are the abandoned `incomplete` ones ended (which can turn up a
     * payment that just went through). An `incomplete` one is never "live": it does not block a
     * new Checkout, nor the deletion of the account, which the portal could not cancel it for.
     */
    async function liveOf(subscriptions: StripeSubscription[]): Promise<StripeSubscription | null> {
      return (
        subscriptions.find((subscription) => ACTIVE_STATUSES.includes(subscription.status)) ??
        (await cancelAbandoned(subscriptions))
      );
    }

    async function checkoutUrl(
      account: Account,
      price: string,
      replaced: string | null,
    ): Promise<string> {
      // One subscription per account: someone who has one changes it in the portal.
      if (isActive(account.subscription_status) && account.stripe_customer_id !== null) {
        await cancelAbandonedBesideLive(account.stripe_customer_id);
        return portalUrl(account.stripe_customer_id);
      }
      // The local status is only as fresh as the last webhook: two Checkouts opened before the
      // first one's event arrived would make two paid subscriptions. Stripe is asked instead.
      if (account.stripe_customer_id !== null) {
        const listed = await subscriptionsOf(account.stripe_customer_id);
        const live = await liveOf(listed);
        if (live) {
          await storeLive(live);
          // `liveOf` ended the abandoned ones itself, unless it found the live one in the list.
          if (listed.includes(live)) {
            await cancelAbandonedBesideLive(account.stripe_customer_id, listed);
          }
          return portalUrl(account.stripe_customer_id);
        }
      }

      const customer = await customerOf(account, replaced);
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
      return session.url;
    }

    app.post('/v1/billing/checkout', ctx.requireAccount, limitBody, async (c) => {
      const price = (await readJsonObject(c))?.price;
      if (typeof price !== 'string' || !Object.hasOwn(PLANS, price)) {
        return c.json({ error: 'invalid_request' }, 400);
      }

      try {
        const url = await withCustomerRecovery(c.get('account'), (account, replaced) =>
          checkoutUrl(account, price, replaced),
        );
        return c.json({ url });
      } catch (error) {
        return stripeFailed(c, 'checkout', error);
      }
    });

    app.post('/v1/billing/portal', ctx.requireAccount, async (c) => {
      const account = c.get('account');
      const customer = account.stripe_customer_id;
      if (customer === null) return c.json({ error: 'no_customer' }, 409);
      try {
        return c.json({ url: await portalUrl(customer) });
      } catch (error) {
        if (isCustomerMissing(error)) {
          forgetCustomer(account, customer);
          return c.json({ error: 'no_customer' }, 409);
        }
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

    // The lazy resync (`/v1/me`, `/v1/search`, `DELETE /v1/account`) shares this very instance:
    // its per-subscription ordering and its once-per-10-minutes memory are in it.
    ctx.subscriptions.refresh = (account) => sync.refresh(account);
    ctx.subscriptions.hasLiveSubscription = async (account) => {
      const customer = account.stripe_customer_id;
      if (customer === null) return false;
      let subscriptions: StripeSubscription[];
      try {
        subscriptions = await subscriptionsOf(customer);
      } catch (error) {
        // A customer Stripe does not know bills nobody.
        if (isCustomerMissing(error)) return false;
        throw error;
      }
      const live = await liveOf(subscriptions);
      if (!live) return false;
      await storeLive(live);
      return true;
    };
    ctx.subscriptions.closeCheckouts = async (account) => {
      const customer = account.stripe_customer_id;
      if (customer === null) return;
      // Every page is read before any session is expired: a cursor must not move under the list.
      const open: Array<{ id: string }> = [];
      try {
        let after: string | undefined;
        let more = true;
        while (more) {
          const page = await stripe.checkout.sessions.list({
            customer,
            status: 'open',
            limit: OPEN_SESSIONS_PAGE,
            ...(after !== undefined && { starting_after: after }),
          });
          open.push(...page.data);
          after = page.data.at(-1)?.id;
          more = page.has_more && after !== undefined;
        }
      } catch (error) {
        // A customer Stripe does not know has nothing to pay.
        if (isCustomerMissing(error)) return;
        throw error;
      }
      for (const session of open) {
        try {
          await stripe.checkout.sessions.expire(session.id);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    };
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
        try {
          await sync.handle(event);
        } catch (error) {
          ctx.alert(
            'webhook-failure',
            `The Stripe event ${event.type} (${event.id}) could not be processed: ` +
              `${error instanceof Error ? error.message : 'unknown error'}. Stripe retries it for ` +
              'a few days; if the cause stays, fix it, then run `npm --prefix server run stripe:resync` ' +
              'to bring every account back in step with Stripe.',
          );
          throw error;
        }
        recordEvent.run(event.id, ctx.now().getTime());
        return c.json({ received: true });
      },
    );
  };
}
