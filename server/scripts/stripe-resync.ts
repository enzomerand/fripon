// Reads again, from Stripe, the subscription of every account that has one, and stores what
// Stripe says (plan, status, period end). For after a webhook outage, a change of price, or a
// switch of Stripe keys. Prints counts only, never an address or an id.
//
// Run it with `npm --prefix server run stripe:resync` (the environment of the server: the database
// of DATABASE_PATH and STRIPE_SECRET_KEY), or, in production, inside the container:
// `docker compose -f server/compose.yml exec -T fripon-cloud node dist/stripe-resync.js`.
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { realStripe } from '../src/stripe';
import { createSubscriptionSync } from '../src/subscription-sync';

try {
  const config = loadConfig();
  const db = openDb(config.databasePath, config.authSecret);
  const sync = createSubscriptionSync({
    stripe: realStripe(config.stripeSecretKey),
    db,
    now: () => Date.now(),
    // Nobody to tell: the owner is the one running this.
    alert: () => undefined,
  });

  const summary = await sync.resyncAll();
  db.close();
  console.log(
    `accounts with a subscription: ${summary.accounts}, synced: ${summary.synced}, ` +
      `cleared (no longer at Stripe): ${summary.cleared}, failed: ${summary.failed}`,
  );
  if (summary.failed > 0) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
