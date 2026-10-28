import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_BANNER, LEGAL_VERSION_DATE, TODO_MARK, frenchDate } from '../legal/page';
import { createTestApp, testConfig } from '../test-helpers';
import { registerLegalRoutes } from './legal';

const PAGES = ['/cgv', '/confidentialite'] as const;

function setup(legalPagesFinal = false, publicUrl = 'https://cloud.fripon.test') {
  return createTestApp([registerLegalRoutes], testConfig({ legalPagesFinal, publicUrl }));
}

async function get(t: ReturnType<typeof setup>, path: string) {
  const response = await t.app.request(path);
  return { response, html: await response.text() };
}

afterEach(() => vi.restoreAllMocks());

describe('GET /cgv and /confidentialite', () => {
  it.each(PAGES)('%s is a small static French page: no script, nothing loaded', async (path) => {
    const { response, html } = await get(setup(), path);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('name="viewport"');
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<form|\bsrc=/i);
    // The only address a page links to outside the service is the CNIL's, as a plain link.
    const external = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((match) => match[1]);
    expect(external.every((href) => href === 'https://www.cnil.fr')).toBe(true);
  });

  it.each(PAGES)('%s wears the draft banner and asks search engines to skip it', async (path) => {
    const { html } = await get(setup(), path);

    expect(DRAFT_BANNER).toBe("Brouillon à faire relire — ne pas publier en l'état");
    expect(html).toContain(DRAFT_BANNER);
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it.each(PAGES)('%s has neither the banner nor the noindex once final', async (path) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response, html } = await get(setup(true), path);

    expect(response.status).toBe(200);
    expect(html).not.toContain('Brouillon');
    expect(html).not.toContain('class="draft"');
    expect(html).not.toContain('noindex');
  });

  it('warns at start when the pages are final while placeholders are left, and only then', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    setup(false);
    expect(warn).not.toHaveBeenCalled();

    setup(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('LEGAL_PAGES_FINAL');
    expect(String(warn.mock.calls[0]?.[0])).toContain(TODO_MARK);
  });

  it.each(PAGES)('%s writes every unknown fact as a well-formed placeholder', async (path) => {
    const { html } = await get(setup(), path);

    const marked = html.split(TODO_MARK).length - 1;
    const wellFormed = html.match(/<mark class="todo">\[À COMPLÉTER : [^\]<]+\]<\/mark>/g) ?? [];
    expect(marked).toBeGreaterThan(0);
    expect(wellFormed).toHaveLength(marked);
  });

  it.each(PAGES)(
    '%s names the publisher company fields, the host and the service by its public address',
    async (path) => {
      const { html } = await get(setup(false, 'https://cloud.fripon.test/'), path);

      // Nothing is filled in the committed object: each company fact is a placeholder, not a person.
      expect(html).not.toContain('Enzo Mérand');
      for (const label of [
        'dénomination sociale',
        'capital social',
        'numéro SIRET',
        'ville du greffe',
      ]) {
        expect(html).toContain(label);
      }
      expect(html).toContain('Hébergeur : OVH SAS, 2 rue Kellermann, 59100 Roubaix, France');
      expect(html).toContain('Adresse du service : https://cloud.fripon.test</li>');
    },
  );

  it.each(PAGES)('%s gives the date of its version', async (path) => {
    const { html } = await get(setup(), path);

    expect(frenchDate('2026-10-27')).toBe('27 octobre 2026');
    expect(frenchDate('2026-11-01')).toBe('1er novembre 2026');
    expect(html).toContain(`Version du ${frenchDate(LEGAL_VERSION_DATE)}`);
  });

  it('links each page to the other', async () => {
    const t = setup();

    expect((await get(t, '/cgv')).html).toContain('href="/confidentialite"');
    expect((await get(t, '/confidentialite')).html).toContain('href="/cgv"');
  });

  it('is not behind an account: no token needed', async () => {
    const t = setup();

    for (const path of PAGES) expect((await t.app.request(path)).status).toBe(200);
  });
});
