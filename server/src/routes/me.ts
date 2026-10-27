import type { RouteModule } from '../context';
import { ACTIVE_STATUSES } from '../plans';
import { usageSummary } from '../quota';

/**
 * `GET /v1/me`: who is signed in, their plan, what is left, and the state of the subscription.
 * `DELETE /v1/account`: deletes the account (see below).
 */
export const registerMeRoute: RouteModule = (app, ctx) => {
  app.get('/v1/me', ctx.requireAccount, async (c) => {
    // A subscription whose period is over, or whose status is not an active one, is read again
    // from Stripe first (at most every 10 minutes): the row may only be missing a webhook.
    const account = await ctx.subscriptions.refresh(c.get('account'));
    return c.json({
      email: account.email,
      ...usageSummary(ctx.db, account, ctx.now()),
      subscription:
        account.subscription_status === null
          ? null
          : { status: account.subscription_status, periodEnd: account.period_end },
    });
  });

  /**
   * Deletes the account and everything that belongs to it: its sessions, usage and reviews (they
   * go with the row), and the rows keyed by its e-mail address (the sign-in code, the wrong
   * guesses). 204 on success; 409 `active_subscription` while Stripe still bills it (active,
   * trialing, past_due, or an incomplete payment that may still go through): it must be cancelled
   * in the portal first, or the card would go on being charged for nothing. Stripe is asked, not
   * only the row, which is as fresh as the last webhook; if Stripe cannot be read the answer is 503
   * `unavailable` and nothing is deleted. The Stripe customer stays at Stripe (invoices must be
   * kept by law); the account's link to it goes with the row.
   */
  app.delete('/v1/account', ctx.requireAccount, async (c) => {
    // The stored status may be late: a subscription that ended is not allowed to block this.
    const account = await ctx.subscriptions.refresh(c.get('account'));
    if (
      account.subscription_status !== null &&
      ACTIVE_STATUSES.includes(account.subscription_status)
    ) {
      return c.json({ error: 'active_subscription' }, 409);
    }
    // The row may be late, or never have heard of a subscription Stripe bills: Stripe decides.
    try {
      if (await ctx.subscriptions.hasLiveSubscription(account)) {
        return c.json({ error: 'active_subscription' }, 409);
      }
    } catch (error) {
      console.error(
        '[account] Stripe could not be read before a deletion, nothing was deleted:',
        error instanceof Error ? error.message : error,
      );
      return c.json({ error: 'unavailable' }, 503);
    }

    ctx.db
      .transaction(() => {
        ctx.db.prepare('DELETE FROM login_codes WHERE email = ?').run(account.email);
        ctx.db.prepare('DELETE FROM login_failures WHERE email = ?').run(account.email);
        ctx.db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
      })
      .immediate();
    return c.body(null, 204);
  });
};
