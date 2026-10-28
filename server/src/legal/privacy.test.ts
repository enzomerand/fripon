import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BACKUP_KEEP_DAYS, PROXY_LOG_KEEP_DAYS, privacyBody } from './privacy';
import { STRIPE_PARAGRAPH_CHECK, duration } from './page';

const html = privacyBody('https://cloud.fripon.test');
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('duration', () => {
  it('says a period the French way', () => {
    expect(duration(15 * 60 * 1000)).toBe('15 minutes');
    expect(duration(60 * 60 * 1000)).toBe('1 heure');
    expect(duration(24 * 60 * 60 * 1000)).toBe('24 heures');
    expect(duration(7 * 24 * 60 * 60 * 1000)).toBe('7 jours');
    expect(duration(90 * 24 * 60 * 60 * 1000)).toBe('90 jours');
    expect(duration(365 * 24 * 60 * 60 * 1000)).toBe('12 mois');
  });
});

describe('the privacy policy', () => {
  // These are the server's real retention periods, read from its constants. They are pinned here
  // so that changing one is a decision: this test, the extension's privacy text
  // (`CLOUD_PRIVACY`), the README and docs/cloud.md then have to be read together.
  it('states the retention periods of the code', () => {
    expect(html).toContain('le code : 15 minutes');
    expect(html).toContain('Une session : 90 jours sans être utilisée, ou 12 mois au plus');
    expect(html).toContain(
      "jusqu'à la fin du mois qui suit celui de l'analyse (deux mois au plus)",
    );
    expect(html).toContain("35 jours pour les résultats d'une recherche d'image");
    expect(html).toContain("7 jours pour ceux d'un avis de l'IA");
    expect(html).toContain('1 heure pour le souvenir');
    expect(html).toContain("l'empreinte des créations de compte : 24 heures");
    expect(html).toContain("L'empreinte des essais de code erronés : 24 heures");
    expect(html).toContain(
      '<strong>Durée de conservation :</strong> 12 mois, même si vous supprimez',
    );
    expect(html).toContain(
      `<strong>Durée de conservation :</strong> ${PROXY_LOG_KEEP_DAYS} jours.`,
    );
    expect(html).toContain(`gardée ${BACKUP_KEEP_DAYS} jours au plus`);
  });

  it('keeps the proxy-log and backup periods in step with the files that set them', () => {
    // Caddy and the backup cron are outside the code: only their files can be read.
    expect(read('../../caddy/fripon.caddy')).toContain(
      `roll_keep_for ${PROXY_LOG_KEEP_DAYS * 24}h`,
    );
    expect(read('../../../docs/cloud.md')).toContain(`-mtime +${BACKUP_KEEP_DAYS} -delete`);
  });

  it('names what is kept for which ground, who receives it, and the rights', () => {
    for (const part of [
      'exécution du contrat',
      'intérêt légitime',
      'obligation légale',
      "n'utilise pas ces données pour améliorer ses produits",
      'Google',
      'Anthropic',
      "n'utilise pas ces données pour entraîner ses modèles",
      'Stripe',
      "prestataire d'envoi d'e-mails",
      "L'hébergeur",
      "en dehors de l'Union européenne",
      'Supprimer mon compte',
      'portabilité',
      'vous opposer',
      'limitation',
      'CNIL',
      'ne dépose aucun cookie',
      'href="/cgv"',
    ]) {
      expect(html).toContain(part);
    }
  });

  it('does not claim that IP addresses are only ever kept hashed (the web server logs them truncated)', () => {
    expect(html).toContain('Une version tronquée dans les journaux du serveur web');
    expect(html).not.toMatch(/adresses IP ne sont gardées que/);
  });

  it('names the host and the e-mail provider, who process in the EU (no transfer outside it)', () => {
    expect(html).toContain(
      "<strong>L'hébergeur</strong> (OVH SAS, 2 rue Kellermann, 59100 Roubaix, France)",
    );
    expect(html).toContain('Strasbourg');
    expect(html).toContain(
      "<strong>Le prestataire d'envoi d'e-mails</strong> (Brevo (Sendinblue SAS), 106 boulevard Haussmann, 75008 Paris, France)",
    );
    expect(html).toContain("dans l'Union européenne : aucun transfert hors de l'Union européenne");
    // The United States transfers (Google, Anthropic) are still the ones described.
    expect(html).toContain('Anthropic est une société américaine');
    // Nobody else is named.
    expect(html).not.toMatch(/resend|postmark|mailgun|sendgrid|scaleway|hetzner|aws/i);
  });

  it('says Stripe is the reseller (merchant of record), with a reminder to check it', () => {
    const stripe = html.slice(
      html.indexOf('<li><strong>Stripe</strong>'),
      html.indexOf('</li>', html.indexOf('<li><strong>Stripe</strong>')),
    );

    expect(stripe).toContain('« merchant of record », offre « Managed Payments »');
    expect(stripe).toContain(
      'il encaisse le paiement, émet le reçu ou la facture, collecte la TVA',
    );
    expect(stripe).toContain(
      'les remboursements demandés sur le paiement et les litiges de paiement',
    );
    expect(stripe).toContain(
      "Le service lui-même (comptes, analyses, plafonds) est fourni par l'éditeur",
    );
    expect(stripe).toContain(`[À COMPLÉTER : ${STRIPE_PARAGRAPH_CHECK}]`);
  });
});
