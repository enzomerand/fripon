import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

const production = {
  NODE_ENV: 'production',
  PUBLIC_URL: 'https://cloud.fripon.test',
  AUTH_SECRET: 'x'.repeat(32),
  SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
  MAIL_FROM: 'Fripon <hello@fripon.test>',
  GOOGLE_VISION_KEY: 'vision-key',
  GEMINI_KEY: 'gemini-key',
  STRIPE_SECRET_KEY: 'sk_live_abc',
  STRIPE_WEBHOOK_SECRET: 'whsec_abc',
  // No default in production: the deployment says whether a reverse proxy is in front.
  TRUST_PROXY: 'true',
  OWNER_EMAIL: 'owner@fripon.test',
};

describe('loadConfig', () => {
  it('has development defaults, only when NODE_ENV=development is set', () => {
    expect(loadConfig({ NODE_ENV: 'development' })).toMatchObject({
      nodeEnv: 'development',
      production: false,
      port: 8787,
      databasePath: './data/fripon.db',
      publicUrl: 'http://localhost:8787',
      smtpUrl: null,
      trustProxy: false,
      ownerEmail: '',
      globalDailyVisionCap: 3000,
      globalDailyReviewCap: 5000,
      aiProvider: 'gemini',
      googleVisionKey: '',
      geminiKey: '',
      anthropicKey: '',
      stripeSecretKey: '',
      stripeWebhookSecret: '',
      stripeRequireTerms: false,
      stripePortalConfiguration: null,
      legalPagesFinal: false,
    });
  });

  it('reads every variable', () => {
    expect(
      loadConfig({
        NODE_ENV: 'test',
        PORT: '9000',
        DATABASE_PATH: '/data/f.db',
        PUBLIC_URL: 'https://cloud.fripon.test',
        AUTH_SECRET: 's3cret',
        SMTP_URL: 'smtp://localhost:1025',
        MAIL_FROM: 'Fripon <a@b.c>',
        TRUST_PROXY: 'true',
        OWNER_EMAIL: 'owner@a.b',
        GLOBAL_DAILY_VISION_CAP: '500',
        GLOBAL_DAILY_REVIEW_CAP: '700',
        AI_PROVIDER: 'claude',
        GOOGLE_VISION_KEY: 'v-key',
        GEMINI_KEY: 'g-key',
        ANTHROPIC_API_KEY: 'sk-ant-api03-abc',
        STRIPE_SECRET_KEY: 'rk_test_abc',
        STRIPE_WEBHOOK_SECRET: 'whsec_xyz',
        STRIPE_REQUIRE_TERMS: 'true',
        STRIPE_PORTAL_CONFIGURATION: 'bpc_123',
        LEGAL_PAGES_FINAL: 'true',
      }),
    ).toEqual({
      nodeEnv: 'test',
      production: false,
      port: 9000,
      databasePath: '/data/f.db',
      publicUrl: 'https://cloud.fripon.test',
      authSecret: 's3cret',
      smtpUrl: 'smtp://localhost:1025',
      mailFrom: 'Fripon <a@b.c>',
      trustProxy: true,
      ownerEmail: 'owner@a.b',
      globalDailyVisionCap: 500,
      globalDailyReviewCap: 700,
      aiProvider: 'claude',
      googleVisionKey: 'v-key',
      geminiKey: 'g-key',
      anthropicKey: 'sk-ant-api03-abc',
      stripeSecretKey: 'rk_test_abc',
      stripeWebhookSecret: 'whsec_xyz',
      stripeRequireTerms: true,
      stripePortalConfiguration: 'bpc_123',
      legalPagesFinal: true,
    });
  });

  it('treats a blank variable as unset', () => {
    const development = { NODE_ENV: 'development' };
    expect(loadConfig({ ...development, PORT: '  ', SMTP_URL: '' }).port).toBe(8787);
    expect(loadConfig({ ...development, SMTP_URL: '' }).smtpUrl).toBeNull();
  });

  it.each([undefined, '', '  '])(
    'reads a missing or blank NODE_ENV as production, never as development: %j',
    (nodeEnv) => {
      // Nothing of development (public secret, codes printed in the log, no Stripe) can apply.
      const error = catchConfigError({ NODE_ENV: nodeEnv });
      expect(error.problems).toEqual(
        expect.arrayContaining([
          expect.stringContaining('AUTH_SECRET'),
          expect.stringContaining('SMTP_URL'),
          expect.stringContaining('STRIPE_SECRET_KEY'),
        ]),
      );
      expect(loadConfig({ ...production, NODE_ENV: nodeEnv })).toMatchObject({
        nodeEnv: 'production',
        production: true,
      });
    },
  );

  it('counts an unknown NODE_ENV as production while it refuses it', () => {
    const error = catchConfigError({ NODE_ENV: 'staging' });
    expect(error.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('NODE_ENV'),
        expect.stringContaining('AUTH_SECRET'),
      ]),
    );
  });

  it('starts the dev server with NODE_ENV=development', () => {
    const script = readFileSync(new URL('../scripts/dev.mjs', import.meta.url), 'utf8');
    expect(script).toMatch(/NODE_ENV:\s*'development'/);
  });

  it('accepts a complete production environment, and trusts the proxy only when told to', () => {
    expect(loadConfig(production)).toMatchObject({ production: true, trustProxy: true });
    expect(loadConfig({ ...production, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...production, TRUST_PROXY: '1' }).trustProxy).toBe(true);
  });

  it('refuses to start in production without TRUST_PROXY said either way', () => {
    const without = Object.fromEntries(
      Object.entries(production).filter(([key]) => key !== 'TRUST_PROXY'),
    );
    expect(catchConfigError(without).problems).toEqual([
      expect.stringContaining('TRUST_PROXY must be set to true or false'),
    ]);
    expect(catchConfigError({ ...production, TRUST_PROXY: '  ' }).problems).toEqual([
      expect.stringContaining('TRUST_PROXY must be set to true or false'),
    ]);
    // A value that is not a boolean is refused too, as ever.
    expect(catchConfigError({ ...production, TRUST_PROXY: 'maybe' }).problems).toEqual([
      expect.stringContaining('TRUST_PROXY must be true or false'),
    ]);
    // Development and tests keep their default.
    expect(loadConfig({ NODE_ENV: 'development' }).trustProxy).toBe(false);
  });

  it('requires OWNER_EMAIL in production, as an address, and leaves it empty in development', () => {
    const without = Object.fromEntries(
      Object.entries(production).filter(([key]) => key !== 'OWNER_EMAIL'),
    );
    expect(catchConfigError(without).problems).toEqual([
      expect.stringContaining('OWNER_EMAIL is required in production'),
    ]);
    expect(catchConfigError({ ...production, OWNER_EMAIL: 'not an address' }).problems).toEqual([
      expect.stringContaining('OWNER_EMAIL must be an e-mail address'),
    ]);
    expect(loadConfig({ NODE_ENV: 'development' }).ownerEmail).toBe('');
  });

  it('requires the secrets, the URL and the mail setup in production, all reported at once', () => {
    const error = catchConfigError({ NODE_ENV: 'production' });
    expect(error.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('PUBLIC_URL'),
        expect.stringContaining('AUTH_SECRET'),
        expect.stringContaining('MAIL_FROM'),
        expect.stringContaining('SMTP_URL'),
        expect.stringContaining('GOOGLE_VISION_KEY'),
        expect.stringContaining('GEMINI_KEY'),
        expect.stringContaining('STRIPE_SECRET_KEY'),
        expect.stringContaining('STRIPE_WEBHOOK_SECRET'),
        expect.stringContaining('OWNER_EMAIL'),
        expect.stringContaining('TRUST_PROXY'),
      ]),
    );
  });

  describe('the AI provider', () => {
    const without = (...names: string[]) =>
      Object.fromEntries(Object.entries(production).filter(([key]) => !names.includes(key)));
    const claude = { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-api03-abc' };

    it('is Gemini unless AI_PROVIDER says claude, and is read whatever its case', () => {
      expect(loadConfig(production).aiProvider).toBe('gemini');
      expect(loadConfig({ ...production, AI_PROVIDER: '  ' }).aiProvider).toBe('gemini');
      expect(loadConfig({ ...production, ...claude, AI_PROVIDER: 'Claude' }).aiProvider).toBe(
        'claude',
      );
    });

    it('requires the Gemini key for Gemini, and not the Anthropic one', () => {
      expect(catchConfigError(without('GEMINI_KEY')).problems).toEqual([
        expect.stringContaining('GEMINI_KEY is required in production'),
      ]);
      expect(loadConfig(production).anthropicKey).toBe('');
    });

    it('requires the Anthropic key for Claude, and no longer the Gemini one', () => {
      expect(
        catchConfigError({ ...without('GEMINI_KEY'), AI_PROVIDER: 'claude' }).problems,
      ).toEqual([expect.stringContaining('ANTHROPIC_API_KEY is required in production')]);
      expect(loadConfig({ ...without('GEMINI_KEY'), ...claude })).toMatchObject({
        aiProvider: 'claude',
        geminiKey: '',
        anthropicKey: 'sk-ant-api03-abc',
      });
    });

    it('keeps the other provider key when it is set, and asks for none in development', () => {
      expect(loadConfig({ ...production, ...claude }).geminiKey).toBe('gemini-key');
      expect(loadConfig({ ...production, ANTHROPIC_API_KEY: 'sk-ant-api03-abc' })).toMatchObject({
        aiProvider: 'gemini',
        anthropicKey: 'sk-ant-api03-abc',
      });
      expect(loadConfig({ NODE_ENV: 'development', AI_PROVIDER: 'claude' })).toMatchObject({
        aiProvider: 'claude',
        anthropicKey: '',
      });
    });

    it('reads the global review ceiling from GLOBAL_DAILY_REVIEW_CAP, or from its old name', () => {
      expect(loadConfig({ NODE_ENV: 'development', GLOBAL_DAILY_GEMINI_CAP: '700' })).toMatchObject(
        {
          globalDailyReviewCap: 700,
        },
      );
      expect(
        loadConfig({
          NODE_ENV: 'development',
          GLOBAL_DAILY_REVIEW_CAP: '900',
          GLOBAL_DAILY_GEMINI_CAP: '700',
        }).globalDailyReviewCap,
      ).toBe(900);
    });
  });

  it('refuses a short AUTH_SECRET in production only', () => {
    expect(() => loadConfig({ ...production, AUTH_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => loadConfig({ NODE_ENV: 'development', AUTH_SECRET: 'short' })).not.toThrow();
  });

  it.each([
    [{ PORT: 'abc' }, 'PORT'],
    [{ PORT: '0' }, 'PORT'],
    [{ PORT: '70000' }, 'PORT'],
    [{ PORT: '80.5' }, 'PORT'],
    [{ GLOBAL_DAILY_VISION_CAP: '-1' }, 'GLOBAL_DAILY_VISION_CAP'],
    [{ GLOBAL_DAILY_REVIEW_CAP: '0' }, 'GLOBAL_DAILY_REVIEW_CAP'],
    [{ GLOBAL_DAILY_GEMINI_CAP: '0' }, 'GLOBAL_DAILY_GEMINI_CAP'],
    [{ AI_PROVIDER: 'openai' }, 'AI_PROVIDER'],
    [{ AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'AIza-not-anthropic' }, 'ANTHROPIC_API_KEY'],
    [{ TRUST_PROXY: 'maybe' }, 'TRUST_PROXY'],
    [{ NODE_ENV: 'staging' }, 'NODE_ENV'],
    [{ PUBLIC_URL: 'not a url' }, 'PUBLIC_URL'],
    [{ STRIPE_SECRET_KEY: 'pk_test_123' }, 'STRIPE_SECRET_KEY'],
    [{ STRIPE_WEBHOOK_SECRET: 'abc' }, 'STRIPE_WEBHOOK_SECRET'],
    [{ STRIPE_REQUIRE_TERMS: 'yes' }, 'STRIPE_REQUIRE_TERMS'],
    [{ LEGAL_PAGES_FINAL: 'yes' }, 'LEGAL_PAGES_FINAL'],
  ])('refuses %j', (env, name) => {
    expect(catchConfigError(env).problems.join('\n')).toContain(name);
  });
});

function catchConfigError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}
