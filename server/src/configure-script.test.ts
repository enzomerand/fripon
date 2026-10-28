import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `server/scripts/configure.sh` run for real in a scratch copy of the server folder, with a fake
 * `docker` first on the PATH: it logs its arguments and, for `stripe-setup.js`, prints what the
 * real one prints (the webhook's signing secret only when it is created). Nothing here touches
 * Docker, Stripe or the real `.env`.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/configure.sh', import.meta.url));

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *stripe-setup.js*)
    if [[ "$*" == *--live* ]]; then echo "Stripe account setup (LIVE mode)"; else echo "Stripe account setup (test mode)"; fi
    if [[ -n "\${FAKE_WHSEC:-}" ]]; then
      echo "webhook: we_fake (created), signing secret: $FAKE_WHSEC"
    else
      echo "webhook: we_fake (found; its signing secret was shown when it was created)"
    fi
    echo "If the portal says there is no default configuration, set STRIPE_PORTAL_CONFIGURATION=bpc_fakeportal1."
    ;;
esac
`;

const SEED_ENV = `PUBLIC_URL=https://fripon.test
OWNER_EMAIL=owner@fripon.test
SMTP_URL=smtp://user:pass@smtp.fripon.test:587
MAIL_FROM=Fripon <no-reply@fripon.test>
GOOGLE_VISION_KEY=AIzaSyFakeFakeFakeFakeFakeFakeFakeFake123
AI_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-fakefakefakefakefakefake
STRIPE_SECRET_KEY=sk_test_oldkey
STRIPE_WEBHOOK_SECRET=whsec_oldtestsecret
STRIPE_REQUIRE_TERMS=false
AUTH_SECRET=0123456789abcdef0123456789abcdef
TRUST_PROXY=true
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A scratch install: server/scripts/configure.sh next to server/.env, and a fake docker. */
function install(env = SEED_ENV) {
  const root = mkdtempSync(join(tmpdir(), 'fripon-configure-'));
  roots.push(root);
  mkdirSync(join(root, 'server/scripts'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  copyFileSync(SCRIPT, join(root, 'server/scripts/configure.sh'));
  writeFileSync(join(root, 'server/.env'), env);
  writeFileSync(join(root, 'bin/docker'), FAKE_DOCKER);
  chmodSync(join(root, 'bin/docker'), 0o755);
  const log = join(root, 'docker.log');
  writeFileSync(log, '');

  const readEnv = (): Record<string, string> =>
    Object.fromEntries(
      readFileSync(join(root, 'server/.env'), 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );

  function run(args: string[], input: string, extraEnv: Record<string, string> = {}) {
    const result = spawnSync('bash', [join(root, 'server/scripts/configure.sh'), ...args], {
      input,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
        FAKE_DOCKER_LOG: log,
        ...extraEnv,
      },
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      docker: readFileSync(log, 'utf8'),
      env: readEnv(),
    };
  }
  return { run, readEnv };
}

/** The six questions before Stripe's (e-mail, SMTP, sender, Vision key, AI provider, Claude key): Entrée keeps each. */
const KEEP_ALL = '\n'.repeat(6);
const LIVE_KEY = 'sk_live_FakeLiveKey123';

describe('configure.sh', () => {
  it('has no syntax error', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  describe('--live', () => {
    it('stores the live key, the new webhook secret and STRIPE_REQUIRE_TERMS=true, and sets Stripe up live', () => {
      const { run } = install();
      const result = run(['--live'], `${KEEP_ALL}${LIVE_KEY}\nLIVE\n`, {
        FAKE_WHSEC: 'whsec_FreshLiveSecret1',
      });

      expect(result.status).toBe(0);
      expect(result.env).toMatchObject({
        STRIPE_SECRET_KEY: LIVE_KEY,
        STRIPE_WEBHOOK_SECRET: 'whsec_FreshLiveSecret1',
        STRIPE_REQUIRE_TERMS: 'true',
        STRIPE_PORTAL_CONFIGURATION: 'bpc_fakeportal1',
      });
      expect(result.docker).toContain(
        'node dist/stripe-setup.js --live --webhook https://fripon.test/v1/stripe/webhook',
      );
      // Bash shows a `read -p` prompt on a terminal only, so the words are read in the script.
      expect(readFileSync(SCRIPT, 'utf8')).toContain('Tape LIVE pour confirmer : ');
      expect(result.output).toContain('PRODUCTION');
      expect(result.output).toContain('mode LIVE');
      // The secrets are never printed.
      expect(result.output).not.toContain(LIVE_KEY);
      expect(result.output).not.toContain('whsec_FreshLiveSecret1');
    });

    it('refuses a test key, and keeps asking until it gets a live one', () => {
      const { run } = install();
      const refused = run(['--live'], `${KEEP_ALL}sk_test_abc123\n`);

      expect(refused.status).not.toBe(0);
      expect(refused.output).toContain('une clé de test est refusée');
      expect(refused.env).toMatchObject({
        STRIPE_SECRET_KEY: 'sk_test_oldkey',
        STRIPE_REQUIRE_TERMS: 'false',
        STRIPE_WEBHOOK_SECRET: 'whsec_oldtestsecret',
      });
      expect(refused.docker).not.toContain('stripe-setup');

      const retried = install().run(['--live'], `${KEEP_ALL}rk_test_abc123\n${LIVE_KEY}\nLIVE\n`, {
        FAKE_WHSEC: 'whsec_FreshLiveSecret1',
      });
      expect(retried.status).toBe(0);
      expect(retried.env.STRIPE_SECRET_KEY).toBe(LIVE_KEY);
    });

    it('accepts a restricted live key (rk_live_…)', () => {
      const { run } = install();
      const result = run(['--live'], `${KEEP_ALL}rk_live_Restricted9\nLIVE\n`, {
        FAKE_WHSEC: 'whsec_FreshLiveSecret1',
      });

      expect(result.status).toBe(0);
      expect(result.env.STRIPE_SECRET_KEY).toBe('rk_live_Restricted9');
    });

    it('refuses anything but the typed LIVE, and writes nothing for Stripe', () => {
      for (const answer of ['live\n', 'yes\n', '\n', '']) {
        const { run } = install();
        const result = run(['--live'], `${KEEP_ALL}${LIVE_KEY}\n${answer}`);

        expect(result.status).not.toBe(0);
        expect(result.output).toContain('Confirmation refusée');
        expect(result.env).toMatchObject({
          STRIPE_SECRET_KEY: 'sk_test_oldkey',
          STRIPE_REQUIRE_TERMS: 'false',
          STRIPE_WEBHOOK_SECRET: 'whsec_oldtestsecret',
        });
        expect(result.docker).not.toContain('stripe-setup');
      }
    });

    it('keeps the current key on Entrée when it already is a live one, still asking to confirm', () => {
      const { run } = install(SEED_ENV.replace('sk_test_oldkey', LIVE_KEY));
      const result = run(['--live'], `${KEEP_ALL}\nLIVE\n`, {
        FAKE_WHSEC: 'whsec_FreshLiveSecret1',
      });

      expect(result.status).toBe(0);
      expect(result.env.STRIPE_SECRET_KEY).toBe(LIVE_KEY);
      expect(result.env.STRIPE_REQUIRE_TERMS).toBe('true');

      // With a test key in the file, Entrée is not an answer.
      const test = install().run(['--live'], `${KEEP_ALL}\n`);
      expect(test.status).not.toBe(0);
      expect(test.output).toContain('Valeur obligatoire');
    });

    it('asks for the webhook secret when the live endpoint already existed (the old one is a test secret)', () => {
      const { run } = install();
      const typed = run(['--live'], `${KEEP_ALL}${LIVE_KEY}\nLIVE\nwhsec_TypedLiveSecret2\n`);

      expect(typed.status).toBe(0);
      expect(typed.output).toContain("le secret enregistré doit être celui de l'endpoint LIVE");
      expect(typed.env.STRIPE_WEBHOOK_SECRET).toBe('whsec_TypedLiveSecret2');
    });
  });

  describe('without --live', () => {
    it('still takes a test key only, stores the new secret and sets Stripe up without --live', () => {
      const { run } = install();
      const result = run([], `${KEEP_ALL}sk_test_newkey1\n`, {
        FAKE_WHSEC: 'whsec_FreshTestSecret3',
      });

      expect(result.status).toBe(0);
      expect(result.env).toMatchObject({
        STRIPE_SECRET_KEY: 'sk_test_newkey1',
        STRIPE_WEBHOOK_SECRET: 'whsec_FreshTestSecret3',
        // Not touched without --live.
        STRIPE_REQUIRE_TERMS: 'false',
      });
      expect(result.docker).toContain(
        'node dist/stripe-setup.js --webhook https://fripon.test/v1/stripe/webhook',
      );
      expect(result.docker).not.toContain('--live');
      expect(result.output).not.toContain('Tape LIVE');
    });

    it('refuses a live key', () => {
      const { run } = install();
      const result = run([], `${KEEP_ALL}${LIVE_KEY}\n`);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Format inattendu');
      expect(result.env.STRIPE_SECRET_KEY).toBe('sk_test_oldkey');
    });
  });

  describe('the other modes', () => {
    it('--anthropic-key and --google-keys read their keys from stdin, as before', () => {
      const { run } = install();

      const anthropic = run(['--anthropic-key'], 'sk-ant-brandnewkeybrandnewkey\n');
      expect(anthropic.status).toBe(0);
      expect(anthropic.env.ANTHROPIC_API_KEY).toBe('sk-ant-brandnewkeybrandnewkey');

      const google = run(['--google-keys'], 'AIzaSyNewVisionKeyNewVisionKeyNewVision1\n');
      expect(google.status).toBe(0);
      expect(google.env.GOOGLE_VISION_KEY).toBe('AIzaSyNewVisionKeyNewVisionKeyNewVision1');

      // None of them runs Docker, and none touches Stripe.
      expect(google.docker).toBe('');
      expect(google.env).toMatchObject({
        STRIPE_SECRET_KEY: 'sk_test_oldkey',
        STRIPE_REQUIRE_TERMS: 'false',
      });
    });

    it('--smtp reads four lines from stdin, as before', () => {
      const { run } = install();
      const result = run(['--smtp'], 'smtp-relay.brevo.com\n587\nlogin@x.test\np@ss word\n');

      expect(result.status).toBe(0);
      expect(result.env.SMTP_URL).toBe(
        'smtp://login%40x.test:p%40ss%20word@smtp-relay.brevo.com:587',
      );
    });
  });
});
