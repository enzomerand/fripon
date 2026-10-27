import type { RouteModule } from '../context';
import { usageSummary } from '../quota';

/** `GET /v1/me`: who is signed in, their plan, what is left, and the state of the subscription. */
export const registerMeRoute: RouteModule = (app, ctx) => {
  app.get('/v1/me', ctx.requireAccount, (c) => {
    const account = c.get('account');
    return c.json({
      email: account.email,
      ...usageSummary(ctx.db, account, ctx.now()),
      subscription:
        account.subscription_status === null
          ? null
          : { status: account.subscription_status, periodEnd: account.period_end },
    });
  });
};
