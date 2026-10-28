/** What a variable can be before it is read: the process environment, or a plain object in tests. */
export type Env = Record<string, string | undefined>;

/** Every problem with the environment, so a deployment fixes them all at once. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

const NODE_ENVS = ['development', 'production', 'test'] as const;

/** The text of a variable, trimmed; `undefined` when it is unset or blank. */
function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === '' ? undefined : value;
}

/**
 * Reads the environment once into a typed, validated object. Each variable is one line of the
 * object below: adding one (`GOOGLE_VISION_KEY`, `STRIPE_SECRET_KEY`...) is one line there, using
 * `text`, `integer`, `flag` or `requiredInProduction`. The type is inferred, so it follows.
 */
export function loadConfig(env: Env = process.env) {
  const problems: string[] = [];

  /** An integer between `min` and `max`; the default when the variable is unset. */
  function integer(name: string, fallback: number, min: number, max: number): number {
    const raw = text(env, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
      return fallback;
    }
    return value;
  }

  /** `true`/`false`/`1`/`0`; the default when the variable is unset. */
  function flag(name: string, fallback: boolean): boolean {
    const raw = text(env, name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    problems.push(`${name} must be true or false (got "${raw}")`);
    return fallback;
  }

  // A missing NODE_ENV is production, never development: development has a public AUTH_SECRET, a
  // mailer that prints the sign-in codes in the logs and no Stripe, so it must be asked for by
  // name (`npm run dev` does). An unknown value is refused, and counts as production meanwhile.
  const rawNodeEnv = text(env, 'NODE_ENV') ?? 'production';
  const nodeEnv = NODE_ENVS.find((name) => name === rawNodeEnv) ?? 'production';
  if (nodeEnv !== rawNodeEnv) {
    problems.push(`NODE_ENV must be development, production or test (got "${rawNodeEnv}")`);
  }
  const production = nodeEnv === 'production';

  /** A variable with no sensible default in production; in development the fallback is used. */
  function requiredInProduction(name: string, devFallback: string): string {
    const raw = text(env, name);
    if (raw !== undefined) return raw;
    if (production) problems.push(`${name} is required in production`);
    return devFallback;
  }

  const port = integer('PORT', 8787, 1, 65_535);

  const config = {
    nodeEnv,
    production,
    port,
    databasePath: text(env, 'DATABASE_PATH') ?? './data/fripon.db',
    publicUrl: requiredInProduction('PUBLIC_URL', `http://localhost:${port}`),
    /** HMAC secret of the sign-in codes: a leak lets anyone forge a valid code. */
    authSecret: requiredInProduction('AUTH_SECRET', 'dev-only-secret-never-use-in-production'),
    /** `null` in development means "print the code in the console" (see `createMailer`). */
    smtpUrl: text(env, 'SMTP_URL') ?? null,
    mailFrom: requiredInProduction('MAIL_FROM', 'Fripon <no-reply@localhost>'),
    /**
     * Read the client address from `X-Forwarded-For`: only right behind the reverse proxy. In
     * production it must be said either way (see below): a wrong default makes every client share
     * the proxy's address, or lets a client write the address it likes.
     */
    trustProxy: flag('TRUST_PROXY', false),
    /**
     * Where the owner's alerts go (a refused Google key, a double subscription, a failing webhook,
     * a dispute, a ceiling reached). Empty in development: nothing is sent.
     */
    ownerEmail: requiredInProduction('OWNER_EMAIL', ''),
    /** Vision calls per day (Pacific time), all accounts together, on top of the Google Cloud quota. */
    globalDailyVisionCap: integer('GLOBAL_DAILY_VISION_CAP', 3_000, 1, 1_000_000),
    /** Gemini reviews per day, all accounts together, on top of the Google quota. */
    globalDailyGeminiCap: integer('GLOBAL_DAILY_GEMINI_CAP', 5_000, 1, 1_000_000),
    /** The owner's Google keys behind the paid steps. Empty in development: Google then refuses. */
    googleVisionKey: requiredInProduction('GOOGLE_VISION_KEY', ''),
    geminiKey: requiredInProduction('GEMINI_KEY', ''),
    /**
     * Set: the reviews go through Vertex AI with this model (`gemini-2.5-flash-lite`...), billed
     * after use on the Cloud invoice, and `GEMINI_KEY` is a Cloud key for aiplatform.googleapis.com.
     * Unset: the Gemini API (`GEMINI_MODEL`), which may require prepaid credits in AI Studio.
     */
    geminiVertexModel: text(env, 'GEMINI_VERTEX_MODEL') ?? null,
    /** Stripe's secret (or restricted) key. Empty in development: Stripe then refuses the call. */
    stripeSecretKey: requiredInProduction('STRIPE_SECRET_KEY', ''),
    /** The signing secret of the webhook endpoint (`whsec_...`): what proves an event is Stripe's. */
    stripeWebhookSecret: requiredInProduction('STRIPE_WEBHOOK_SECRET', ''),
    /**
     * Ask the buyer to accept the terms at Checkout (service starts at once, 14-day withdrawal right
     * waived). Stripe needs a terms-of-service URL in the Dashboard first, hence off by default.
     */
    stripeRequireTerms: flag('STRIPE_REQUIRE_TERMS', false),
    /**
     * The portal configuration (`bpc_...`) to open when the account has no default one in the
     * Dashboard; `npm run stripe:setup` prints it. `null` lets Stripe use its default.
     */
    stripePortalConfiguration: text(env, 'STRIPE_PORTAL_CONFIGURATION') ?? null,
    /**
     * The terms of sale (`/cgv`) and the privacy policy (`/confidentialite`) are drafts: each page
     * wears a "to be reviewed" banner until this is true, to be set once every placeholder is
     * filled in and the owner has read both pages.
     */
    legalPagesFinal: flag('LEGAL_PAGES_FINAL', false),
  };

  if (production && config.authSecret.length < 32) {
    problems.push('AUTH_SECRET must be at least 32 characters in production');
  }
  if (production && config.smtpUrl === null) problems.push('SMTP_URL is required in production');
  // No default in production: the right value depends on whether a reverse proxy is in front.
  if (production && text(env, 'TRUST_PROXY') === undefined) {
    problems.push('TRUST_PROXY must be set to true or false in production');
  }
  if (config.ownerEmail !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.ownerEmail)) {
    problems.push(`OWNER_EMAIL must be an e-mail address (got "${config.ownerEmail}")`);
  }
  if (config.stripeSecretKey !== '' && !/^(sk|rk)_(test|live)_/.test(config.stripeSecretKey)) {
    problems.push('STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_... or rk_...)');
  }
  if (config.stripeWebhookSecret !== '' && !config.stripeWebhookSecret.startsWith('whsec_')) {
    problems.push('STRIPE_WEBHOOK_SECRET must be a webhook signing secret (whsec_...)');
  }
  try {
    new URL(config.publicUrl);
  } catch {
    problems.push(`PUBLIC_URL must be a URL (got "${config.publicUrl}")`);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

export type Config = ReturnType<typeof loadConfig>;
