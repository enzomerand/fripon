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

  const rawNodeEnv = text(env, 'NODE_ENV') ?? 'development';
  const nodeEnv = NODE_ENVS.find((name) => name === rawNodeEnv) ?? 'development';
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
    /** Read the client address from `X-Forwarded-For`: only right behind the reverse proxy. */
    trustProxy: flag('TRUST_PROXY', production),
    /** Vision calls per day, all accounts together, on top of the Google Cloud quota. */
    globalDailyVisionCap: integer('GLOBAL_DAILY_VISION_CAP', 3_000, 1, 1_000_000),
    /** The owner's Google keys behind the paid steps. Empty in development: Google then refuses. */
    googleVisionKey: requiredInProduction('GOOGLE_VISION_KEY', ''),
    geminiKey: requiredInProduction('GEMINI_KEY', ''),
  };

  if (production && config.authSecret.length < 32) {
    problems.push('AUTH_SECRET must be at least 32 characters in production');
  }
  if (production && config.smtpUrl === null) problems.push('SMTP_URL is required in production');
  try {
    new URL(config.publicUrl);
  } catch {
    problems.push(`PUBLIC_URL must be a URL (got "${config.publicUrl}")`);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

export type Config = ReturnType<typeof loadConfig>;
