// Sets a Stripe account up for Fripon Cloud (product, prices, customer portal, optional webhook).
// Run it with `npm --prefix server run stripe:setup [-- --webhook https://.../v1/stripe/webhook]`.
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../src/stripe';
import { checkedKey, parseArgs, runSetup } from '../src/stripe-setup';

try {
  const args = parseArgs(process.argv.slice(2));
  const key = checkedKey(process.env.STRIPE_SECRET_KEY, args.live);
  const mode = key.includes('_live_') ? 'LIVE' : 'test';
  console.log(`Stripe account setup (${mode} mode)`);

  const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2 });
  const summary = await runSetup(stripe, args, console.log);

  console.log('');
  const portalHint = `If the portal says there is no default configuration, set STRIPE_PORTAL_CONFIGURATION=${summary.portal.id}.`;
  console.log(portalHint);
  if (summary.webhook === null) {
    console.log('No webhook endpoint touched: pass --webhook <https url> to create it.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
