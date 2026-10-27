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
};

describe('loadConfig', () => {
  it('has development defaults', () => {
    expect(loadConfig({})).toMatchObject({
      nodeEnv: 'development',
      production: false,
      port: 8787,
      databasePath: './data/fripon.db',
      publicUrl: 'http://localhost:8787',
      smtpUrl: null,
      trustProxy: false,
      globalDailyVisionCap: 3000,
      googleVisionKey: '',
      geminiKey: '',
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
        GLOBAL_DAILY_VISION_CAP: '500',
        GOOGLE_VISION_KEY: 'v-key',
        GEMINI_KEY: 'g-key',
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
      globalDailyVisionCap: 500,
      googleVisionKey: 'v-key',
      geminiKey: 'g-key',
    });
  });

  it('treats a blank variable as unset', () => {
    expect(loadConfig({ PORT: '  ', SMTP_URL: '' }).port).toBe(8787);
    expect(loadConfig({ SMTP_URL: '' }).smtpUrl).toBeNull();
  });

  it('accepts a complete production environment, and trusts the proxy by default there', () => {
    expect(loadConfig(production)).toMatchObject({ production: true, trustProxy: true });
    expect(loadConfig({ ...production, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
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
      ]),
    );
  });

  it('refuses a short AUTH_SECRET in production only', () => {
    expect(() => loadConfig({ ...production, AUTH_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => loadConfig({ AUTH_SECRET: 'short' })).not.toThrow();
  });

  it.each([
    [{ PORT: 'abc' }, 'PORT'],
    [{ PORT: '0' }, 'PORT'],
    [{ PORT: '70000' }, 'PORT'],
    [{ PORT: '80.5' }, 'PORT'],
    [{ GLOBAL_DAILY_VISION_CAP: '-1' }, 'GLOBAL_DAILY_VISION_CAP'],
    [{ TRUST_PROXY: 'maybe' }, 'TRUST_PROXY'],
    [{ NODE_ENV: 'staging' }, 'NODE_ENV'],
    [{ PUBLIC_URL: 'not a url' }, 'PUBLIC_URL'],
  ])('refuses %j', (env, name) => {
    expect(catchConfigError(env).problems.join('\n')).toContain(name);
  });
});

function catchConfigError(env: Record<string, string>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}
