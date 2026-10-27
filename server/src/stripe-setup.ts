import type Stripe from 'stripe';
import type { PriceLookupKey } from './plans';
import { STRIPE_API_VERSION, WEBHOOK_EVENTS } from './stripe';

/**
 * Sets a Stripe account up for Fripon Cloud, once or again: the product, the three prices (found
 * by their lookup key), the customer portal and, when asked, the webhook endpoint. Every step looks
 * before it creates, so running it twice changes nothing. Run by `npm run stripe:setup`.
 */

export const PRODUCT_NAME = 'Fripon';
/** Marks what this script made, so a renamed product or portal is still found. */
const PRODUCT_TAG = { fripon: 'cloud' };
const PORTAL_TAG = { fripon: 'portal' };

/** The prices: what the owner decided, in cents, tax included. The keys are the ones `plans.ts` reads. */
export const PRICE_SPECS: Record<
  PriceLookupKey,
  { amount: number; interval: 'month' | 'year'; nickname: string }
> = {
  essentiel_monthly: { amount: 299, interval: 'month', nickname: 'Essentiel mensuel' },
  essentiel_yearly: { amount: 2999, interval: 'year', nickname: 'Essentiel annuel' },
  revendeur_monthly: { amount: 699, interval: 'month', nickname: 'Revendeur mensuel' },
};

const CURRENCY = 'eur';

/** A page of a Stripe list. */
interface Page<T> {
  data: T[];
  has_more: boolean;
}

interface SetupProduct {
  id: string;
  name: string;
  metadata: Record<string, string>;
}

interface SetupPrice {
  id: string;
  active: boolean;
  lookup_key: string | null;
  unit_amount: number | null;
  currency: string;
  tax_behavior?: string | null;
  recurring: { interval: string; interval_count: number } | null;
  product: string | { id: string };
}

interface SetupPortal {
  id: string;
  metadata: Record<string, string> | null;
}

interface SetupWebhook {
  id: string;
  url: string;
  enabled_events: string[];
}

/** The calls the setup makes, and the fields it reads. The real one is the SDK, tests pass a fake. */
export interface SetupApi {
  products: {
    list(params: {
      active: boolean;
      limit: number;
      starting_after?: string;
    }): Promise<Page<SetupProduct>>;
    create(params: Stripe.ProductCreateParams): Promise<SetupProduct>;
  };
  prices: {
    list(params: { lookup_keys: string[]; limit: number }): Promise<Page<SetupPrice>>;
    create(params: Stripe.PriceCreateParams): Promise<SetupPrice>;
  };
  billingPortal: {
    configurations: {
      list(params: { limit: number; starting_after?: string }): Promise<Page<SetupPortal>>;
      create(params: Stripe.BillingPortal.ConfigurationCreateParams): Promise<SetupPortal>;
      update(
        id: string,
        params: Stripe.BillingPortal.ConfigurationUpdateParams,
      ): Promise<SetupPortal>;
    };
  };
  webhookEndpoints: {
    list(params: { limit: number; starting_after?: string }): Promise<Page<SetupWebhook>>;
    create(params: Stripe.WebhookEndpointCreateParams): Promise<SetupWebhook & { secret?: string }>;
    update(id: string, params: Stripe.WebhookEndpointUpdateParams): Promise<SetupWebhook>;
  };
}

export type Outcome = 'created' | 'found' | 'updated' | 'replaced';

export interface SetupSummary {
  product: { id: string; outcome: 'created' | 'found' };
  prices: Array<{ lookupKey: string; id: string; outcome: Outcome; replaced?: string }>;
  portal: { id: string; outcome: 'created' | 'updated' };
  webhook: null | { id: string; outcome: 'created' | 'updated' | 'found'; secret: string | null };
}

export interface SetupOptions {
  /** Create (or complete) the webhook endpoint at this URL. */
  webhookUrl: string | null;
}

/** Every item of a Stripe list, page after page. */
async function all<T extends { id: string }>(
  page: (startingAfter?: string) => Promise<Page<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const { data, has_more } = await page(startingAfter);
    items.push(...data);
    const last = data[data.length - 1];
    if (!has_more || !last) return items;
    startingAfter = last.id;
  }
}

const productIdOf = (price: SetupPrice): string =>
  typeof price.product === 'string' ? price.product : price.product.id;

/** Whether a price is already what the spec says (a price cannot be edited: it is replaced). */
function matches(price: SetupPrice, spec: (typeof PRICE_SPECS)[PriceLookupKey], productId: string) {
  return (
    price.active &&
    price.unit_amount === spec.amount &&
    price.currency === CURRENCY &&
    price.recurring?.interval === spec.interval &&
    price.recurring.interval_count === 1 &&
    price.tax_behavior === 'inclusive' &&
    productIdOf(price) === productId
  );
}

export async function runSetup(
  stripe: SetupApi,
  options: SetupOptions,
  log: (line: string) => void,
): Promise<SetupSummary> {
  // The product: ours by its tag, else any active one called "Fripon", else a new one.
  const products = await all((after) =>
    stripe.products.list({ active: true, limit: 100, starting_after: after }),
  );
  const existing =
    products.find((product) => product.metadata.fripon === PRODUCT_TAG.fripon) ??
    products.find((product) => product.name === PRODUCT_NAME);
  const product =
    existing ??
    (await stripe.products.create({
      name: PRODUCT_NAME,
      description: "Analyses d'annonces Vinted : recherche d'image et avis IA.",
      metadata: PRODUCT_TAG,
    }));
  const productOutcome = existing ? 'found' : 'created';
  log(`product ${PRODUCT_NAME}: ${product.id} (${productOutcome})`);

  // The prices, one lookup key each. A key held by a price that is not what the spec says (another
  // amount, archived...) moves to a new price: the old one keeps serving the subscriptions on it.
  const prices: SetupSummary['prices'] = [];
  for (const [lookupKey, spec] of Object.entries(PRICE_SPECS)) {
    const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 10 });
    const held = data.find((price) => price.lookup_key === lookupKey);
    if (held && matches(held, spec, product.id)) {
      prices.push({ lookupKey, id: held.id, outcome: 'found' });
      log(`price ${lookupKey}: ${held.id} (found)`);
      continue;
    }

    const created = await stripe.prices.create({
      product: product.id,
      currency: CURRENCY,
      unit_amount: spec.amount,
      recurring: { interval: spec.interval },
      lookup_key: lookupKey,
      tax_behavior: 'inclusive',
      nickname: spec.nickname,
      ...(held && { transfer_lookup_key: true }),
    });
    prices.push({
      lookupKey,
      id: created.id,
      outcome: held ? 'replaced' : 'created',
      ...(held && { replaced: held.id }),
    });
    log(
      held
        ? `price ${lookupKey}: ${created.id} (replaced ${held.id}, which differs: archive it in the Dashboard once nobody is on it)`
        : `price ${lookupKey}: ${created.id} (created)`,
    );
  }

  // The customer portal: cancel at the end of the period, card, invoices, and a switch between the
  // three prices. Ours is found by its tag and brought up to date, so a price change shows in it.
  const portalParams: Stripe.BillingPortal.ConfigurationCreateParams = {
    name: 'Fripon',
    metadata: PORTAL_TAG,
    business_profile: { headline: 'Gère ton abonnement Fripon' },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        proration_behavior: 'none',
        cancellation_reason: {
          enabled: true,
          options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'],
        },
      },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'create_prorations',
        products: [{ product: product.id, prices: prices.map((price) => price.id) }],
      },
    },
  };
  const portals = await all((after) =>
    stripe.billingPortal.configurations.list({ limit: 100, starting_after: after }),
  );
  const ourPortal = portals.find((portal) => portal.metadata?.fripon === PORTAL_TAG.fripon);
  const portal = ourPortal
    ? await stripe.billingPortal.configurations.update(ourPortal.id, portalParams)
    : await stripe.billingPortal.configurations.create(portalParams);
  const portalOutcome = ourPortal ? 'updated' : 'created';
  log(`customer portal: ${portal.id} (${portalOutcome})`);

  const webhook =
    options.webhookUrl === null ? null : await ensureWebhook(stripe, options.webhookUrl, log);

  return {
    product: { id: product.id, outcome: productOutcome },
    prices,
    portal: { id: portal.id, outcome: portalOutcome },
    webhook,
  };
}

/** The webhook endpoint for the events the server handles; its signing secret exists at creation only. */
async function ensureWebhook(
  stripe: SetupApi,
  url: string,
  log: (line: string) => void,
): Promise<NonNullable<SetupSummary['webhook']>> {
  const endpoints = await all((after) =>
    stripe.webhookEndpoints.list({ limit: 100, starting_after: after }),
  );
  const found = endpoints.find((endpoint) => endpoint.url === url);

  if (found) {
    const wanted = [...WEBHOOK_EVENTS];
    const complete = wanted.every((event) => found.enabled_events.includes(event));
    if (!complete) {
      await stripe.webhookEndpoints.update(found.id, { enabled_events: wanted });
      log(
        `webhook ${url}: ${found.id} (events updated; its signing secret was shown when it was created)`,
      );
      return { id: found.id, outcome: 'updated', secret: null };
    }
    log(`webhook ${url}: ${found.id} (found; its signing secret was shown when it was created)`);
    return { id: found.id, outcome: 'found', secret: null };
  }

  const created = await stripe.webhookEndpoints.create({
    url,
    enabled_events: [...WEBHOOK_EVENTS],
    description: 'Fripon Cloud',
    // The events are rendered in the API version the server's types describe, not the account's.
    api_version: STRIPE_API_VERSION,
  });
  log(`webhook ${url}: ${created.id} (created)`);
  log(
    `signing secret (shown once, put it in STRIPE_WEBHOOK_SECRET): ${created.secret ?? '(none returned)'}`,
  );
  return { id: created.id, outcome: 'created', secret: created.secret ?? null };
}

/** What the command line asked for. */
export interface CliArgs extends SetupOptions {
  live: boolean;
}

/** `--webhook <url>`, `--live`; anything else is an error worth stopping for. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { webhookUrl: null, live: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === '--live') {
      args.live = true;
    } else if (arg === '--webhook' || arg.startsWith('--webhook=')) {
      const value = arg === '--webhook' ? argv[++index] : arg.slice('--webhook='.length);
      if (!value) throw new Error('--webhook needs a URL');
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new Error(`--webhook needs a URL (got "${value}")`);
      }
      if (url.protocol !== 'https:') throw new Error('--webhook needs an https URL');
      args.webhookUrl = url.href;
    } else {
      throw new Error(
        `Unknown argument "${arg}". Usage: stripe:setup [--webhook <https url>] [--live]`,
      );
    }
  }
  return args;
}

/** The key to use, after the checks that keep a test run from touching real money. */
export function checkedKey(raw: string | undefined, live: boolean): string {
  const key = raw?.trim() ?? '';
  if (key === '') throw new Error('STRIPE_SECRET_KEY is not set (put a test key in server/.env)');
  if (!/^(sk|rk)_(test|live)_/.test(key)) {
    throw new Error(
      'STRIPE_SECRET_KEY is not a Stripe secret or restricted key (sk_... or rk_...)',
    );
  }
  if (/^(sk|rk)_live_/.test(key) && !live) {
    throw new Error(
      'STRIPE_SECRET_KEY is a live key: run with --live if that is really what you want',
    );
  }
  return key;
}
