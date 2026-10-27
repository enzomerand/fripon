import type { RouteModule } from '../context';
import { cgvBody } from '../legal/cgv';
import { TODO_MARK, legalPage } from '../legal/page';
import { privacyBody } from '../legal/privacy';
import { PAGE_CSP } from './billing';

/**
 * The terms of sale (`GET /cgv`) and the privacy policy (`GET /confidentialite`): two static
 * pages, in the spirit of `/billing/done` (no script, nothing loaded, nothing personal). The
 * address of `/cgv` is what the Stripe Dashboard shows as "Terms of service" (docs/cloud.md).
 *
 * They are drafts until `LEGAL_PAGES_FINAL=true`: each wears a banner and asks search engines to
 * skip it. Marking them final while a `[À COMPLÉTER : ...]` is left is allowed (the owner decides)
 * but warned about at start.
 */
export const registerLegalRoutes: RouteModule = (app, ctx) => {
  const final = ctx.config.legalPagesFinal;
  const serviceUrl = ctx.config.publicUrl.replace(/\/+$/, '');

  const pages = {
    '/cgv': legalPage({
      title: "Conditions générales de vente et d'utilisation de Fripon Cloud",
      seeAlso: { href: '/confidentialite', label: 'Politique de confidentialité' },
      final,
      body: cgvBody(serviceUrl),
    }),
    '/confidentialite': legalPage({
      title: 'Politique de confidentialité de Fripon Cloud',
      seeAlso: { href: '/cgv', label: "Conditions générales de vente et d'utilisation" },
      final,
      body: privacyBody(serviceUrl),
    }),
  };

  if (final) {
    const left = Object.values(pages).reduce((n, html) => n + html.split(TODO_MARK).length - 1, 0);
    if (left > 0) {
      console.warn(
        `[legal] LEGAL_PAGES_FINAL is true but the legal pages still hold ${left} "${TODO_MARK} : ..." placeholders: fill them in (server/src/legal/).`,
      );
    }
  }

  for (const [path, html] of Object.entries(pages)) {
    app.get(path, (c) => {
      c.header('Content-Security-Policy', PAGE_CSP);
      return c.html(html);
    });
  }
};
