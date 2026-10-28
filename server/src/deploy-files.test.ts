import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

/** What the deployment files must keep saying: nothing runs them here, so a test reads them. */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('server/Dockerfile', () => {
  const dockerfile = read('Dockerfile');

  it('starts every stage from an exact Node 22 version, never a floating tag', () => {
    const stages = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
    expect(stages).toHaveLength(2);
    for (const image of stages) expect(image).toMatch(/^node:22\.\d+\.\d+-bookworm-slim$/);
  });

  it('builds and ships the resync command next to the server bundle', () => {
    expect(dockerfile).toContain('npm run build:resync');
    expect(dockerfile).toMatch(/COPY --from=build \S+\/dist\/stripe-resync\.js/);
    expect(dockerfile).toContain('COPY server/scripts ./scripts');
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts['stripe:resync']).toContain('dist/stripe-resync.js');
    expect(scripts['build:resync']).toContain('scripts/stripe-resync.ts');
  });

  it('is built from a context that holds the scripts it copies', () => {
    const ignore = readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8');
    expect(ignore.split('\n')).not.toContain('server/scripts');
  });
});

describe('server/caddy/fripon.caddy', () => {
  const caddy = read('caddy/fripon.caddy');

  it('masks client addresses in the log, and drops the headers that carry one or a credential', () => {
    for (const field of ['request>remote_ip', 'request>client_ip']) {
      expect(caddy).toMatch(new RegExp(`${field} ip_mask \\{\\s+ipv4 \\d+\\s+ipv6 \\d+\\s+\\}`));
    }
    expect(caddy).toContain('request>headers>X-Forwarded-For delete');
    expect(caddy).toContain('request>headers>Authorization delete');
  });

  it('keeps the logs 7 days', () => {
    expect(caddy).toMatch(/roll_keep_for 168h/);
  });
});

describe('server/.env.example', () => {
  const example = read('.env.example');

  it('asks for the two variables production refuses to start without', () => {
    expect(example).toMatch(/^OWNER_EMAIL=/m);
    expect(example).toMatch(/^TRUST_PROXY=(true|false)$/m);
  });

  it('picks Claude for the AI review, and asks for its key rather than for a Gemini one', () => {
    expect(example).toMatch(/^AI_PROVIDER=claude$/m);
    expect(example).toMatch(/^ANTHROPIC_API_KEY=sk-ant-/m);
    expect(example).not.toMatch(/^GEMINI_KEY=/m);
  });

  it('is a complete production environment once its placeholders are filled in', () => {
    const env: Record<string, string> = {};
    for (const line of example.split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      if (match) env[match[1] as string] = match[2] as string;
    }
    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: 'production',
        AUTH_SECRET: 'x'.repeat(32),
        STRIPE_SECRET_KEY: 'sk_test_abc',
        STRIPE_WEBHOOK_SECRET: 'whsec_abc',
      }),
    ).not.toThrow();
  });
});
