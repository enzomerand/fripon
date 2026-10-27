import { AI_CACHE_TTL_MS } from '../../../lib/ai/review-key';
import {
  CODE_WINDOW_MS,
  LOGIN_FAILURE_WINDOW_MS,
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
  SIGNUP_WINDOW_MS,
  TRIAL_CLAIM_KEEP_MS,
} from '../auth';
import { NEGATIVE_CACHE_TTL_MS, VISION_SERVER_CACHE_TTL_MS } from '../routes/proxy';
import { contact, duration, publisherList, todo } from './page';

/**
 * How long Caddy keeps its access logs. It is written in `server/caddy/fripon.caddy`
 * (`roll_keep_for 168h`), outside the code: a test reads that file and compares.
 */
export const PROXY_LOG_KEEP_DAYS = 7;

/**
 * How long a backup of the database is kept. It is the rotation of `docs/cloud.md`
 * (`find ... -mtime +30 -delete`), run by the owner's cron: a test reads that file and compares.
 */
export const BACKUP_KEEP_DAYS = 30;

/** One kind of data: what, what for, on which legal ground, for how long. Read well on a phone. */
function item(
  title: string,
  rows: { data: string; why: string; basis: string; keep: string },
): string {
  return `<div class="item">
<h3>${title}</h3>
<p><strong>Données :</strong> ${rows.data}</p>
<p><strong>Pourquoi :</strong> ${rows.why}</p>
<p><strong>Base légale :</strong> ${rows.basis}</p>
<p><strong>Durée de conservation :</strong> ${rows.keep}</p>
</div>`;
}

/** The privacy policy, as the HTML of the page's body (the page around it is `legalPage`). */
export function privacyBody(serviceUrl: string): string {
  const contract = 'exécution du contrat (les <a href="/cgv">conditions</a> que vous acceptez)';
  const legitimate = "intérêt légitime de l'éditeur";

  return `
<p>Cette politique explique quelles données personnelles Fripon Cloud, l'abonnement de l'extension Fripon, traite, pourquoi, pendant combien de temps, et quels sont vos droits.</p>
<p>Sans abonnement, avec vos propres clés Google, l'extension n'a aucun serveur : l'éditeur ne reçoit alors aucune donnée. Fripon ne mesure rien : pas de publicité, pas d'outil de suivi ni de mesure d'audience, et le serveur ne dépose aucun cookie.</p>

<h2>1. Responsable du traitement</h2>
<p>Le responsable du traitement est l'éditeur de Fripon Cloud :</p>
${publisherList(serviceUrl)}

<h2>2. Les données, leur usage et leur durée</h2>

${item('Votre compte', {
  data: "votre adresse e-mail, une version simplifiée de cette adresse (sans la partie « +étiquette », et sans les points pour une adresse Gmail), un identifiant de compte, la date de création et le nombre d'analyses d'essai qu'il vous reste.",
  why: 'créer votre compte, vous connecter, vous envoyer votre code de connexion, suivre votre essai gratuit.',
  basis: contract,
  keep: "jusqu'à la suppression de votre compte. Il n'y a pas de suppression automatique d'un compte inactif.",
})}

${item('Votre abonnement', {
  data: "l'identifiant de votre client et de votre abonnement chez Stripe, votre offre, l'état de l'abonnement et la date de fin de la période en cours. Jamais de numéro de carte.",
  why: 'savoir quelles analyses vous pouvez faire.',
  basis: contract,
  keep: "jusqu'à la suppression de votre compte.",
})}

${item('Connexion : codes et sessions', {
  data: "une empreinte du code de connexion (pas le code lui-même), avec votre adresse e-mail et le nombre d'essais ; pour chaque appareil connecté, une empreinte du jeton de session (pas le jeton lui-même) et ses dates de création et de dernière utilisation.",
  why: 'vous connecter et garder votre session ouverte.',
  basis: contract,
  keep: `le code : ${duration(CODE_WINDOW_MS)}, puis il est effacé par un nettoyage automatique qui passe toutes les heures. Une session : ${duration(SESSION_IDLE_MS)} sans être utilisée, ou ${duration(SESSION_MAX_AGE_MS)} au plus même si vous l'utilisez chaque jour. Les sessions disparaissent aussi avec le compte.`,
})}

${item('Vos analyses', {
  data: "pour chaque annonce analysée : l'adresse de sa photo (sans paramètres), le mois et le jour de l'analyse, et le nombre d'avis de l'IA demandés pour cette photo dans le mois.",
  why: "compter vos analyses selon votre offre, rendre gratuite une annonce déjà analysée le même mois, limiter le nombre d'avis de l'IA par annonce.",
  basis: contract,
  keep: "jusqu'à la fin du mois qui suit celui de l'analyse (deux mois au plus), ou jusqu'à la suppression de votre compte si elle vient avant.",
})}

${item('Ce qui est envoyé pour analyser une annonce', {
  data: "l'adresse de la photo, le titre, la description, le prix et les indices calculés par l'extension. Fripon Cloud télécharge lui-même la photo depuis les serveurs d'images de Vinted. La photo est envoyée à Google Cloud Vision (recherche d'image) ; la photo, le titre, la description, le prix et les indices sont envoyés à Google Gemini (avis de l'IA). Une photo d'annonce peut montrer des personnes.",
  why: "obtenir la recherche d'image et l'avis de l'IA que vous avez demandés.",
  basis: contract,
  keep: `Fripon Cloud ne garde ni l'image ni les textes (titre, description, prix, indices). Il garde seulement le résultat, dans un cache partagé entre tous les comptes et qui n'est pas relié au vôtre : ${duration(VISION_SERVER_CACHE_TTL_MS)} pour les résultats d'une recherche d'image (les pages web où la photo a été retrouvée), ${duration(AI_CACHE_TTL_MS)} pour ceux d'un avis de l'IA, et ${duration(NEGATIVE_CACHE_TTL_MS)} pour le souvenir d'une photo que Google n'a pas su lire.`,
})}

${item('Lutte contre les abus et sécurité', {
  data: "votre adresse IP, sous trois formes. (1) Une empreinte (hachage à clé), jamais l'adresse elle-même, gardée pour limiter le nombre de comptes créés depuis une même adresse et les essais de code erronés. (2) L'adresse elle-même, en mémoire vive seulement (jamais écrite sur le disque), pour limiter le nombre de demandes de code : une heure au plus, et effacée dès que le serveur s'arrête. (3) Une version tronquée dans les journaux du serveur web (voir plus bas).",
  why: 'protéger le service contre les abus et la fraude, et en maîtriser le coût (chaque analyse est payée à Google).',
  basis: `${legitimate} (sécurité et lutte contre la fraude).`,
  keep: `l'empreinte des créations de compte : ${duration(SIGNUP_WINDOW_MS)}. L'empreinte des essais de code erronés : ${duration(LOGIN_FAILURE_WINDOW_MS)}.`,
})}

${item('Un seul essai gratuit par boîte e-mail', {
  data: "une empreinte (hachage à clé) de la version simplifiée de votre adresse e-mail. L'adresse elle-même n'est pas dans ce registre.",
  why: "éviter qu'un essai gratuit serve plusieurs fois en recréant un compte.",
  basis: `${legitimate} (éviter l'abus de l'essai gratuit).`,
  keep: `${duration(TRIAL_CLAIM_KEEP_MS)}, même si vous supprimez votre compte entre-temps.`,
})}

${item('Journaux du serveur web', {
  data: "la date, l'adresse IP tronquée (les trois premiers octets d'une adresse IPv4, le préfixe d'une adresse IPv6), la page demandée sans ses paramètres (les identifiants longs sont masqués), le code de réponse et certains en-têtes de la requête, comme le nom du navigateur. Les en-têtes d'authentification, les cookies et la signature de Stripe en sont retirés.",
  why: 'comprendre un incident récent et protéger le service.',
  basis: `${legitimate} (sécurité et bon fonctionnement du service).`,
  keep: `${PROXY_LOG_KEEP_DAYS} jours.`,
})}

${item('Paiement et factures', {
  data: "les informations de paiement et de facturation que la page de paiement de Stripe vous demande, et vos factures. Fripon Cloud reçoit de Stripe l'état de votre abonnement, jamais votre numéro de carte.",
  why: 'encaisser votre abonnement et vous facturer.',
  basis: 'exécution du contrat, et obligation légale pour la conservation des factures.',
  keep: "Stripe et l'éditeur conservent les factures et les pièces comptables pendant la durée légale de conservation des documents comptables, même si vous supprimez votre compte.",
})}

<p><strong>Sauvegardes.</strong> La base de données est sauvegardée, et chaque sauvegarde est gardée ${BACKUP_KEEP_DAYS} jours au plus. Un compte supprimé disparaît donc aussi des sauvegardes dans ce délai.</p>

<h2>3. Qui reçoit vos données</h2>
<ul>
<li><strong>Google</strong> (Google Cloud : Vision pour la recherche d'image, Gemini pour l'avis de l'IA) reçoit ce qui est décrit plus haut pour chaque analyse. Fripon Cloud l'appelle avec la clé payante de l'éditeur : dans ce cadre, Google n'utilise pas ces données pour améliorer ses produits.</li>
<li><strong>Stripe</strong> traite les paiements et les abonnements, selon sa propre politique de confidentialité. Il reçoit votre adresse e-mail et l'identifiant de votre compte Fripon.</li>
<li><strong>Le prestataire d'envoi d'e-mails</strong> (${todo("nom du prestataire d'envoi d'e-mails")}) reçoit votre adresse e-mail et le code de connexion pour vous les envoyer.</li>
<li><strong>L'hébergeur</strong> (${todo("nom de l'hébergeur")}) héberge le serveur et sa base de données.</li>
</ul>
<p>L'éditeur ne vend pas vos données et ne les utilise pas pour de la publicité.</p>

<h2>4. Transferts hors de l'Union européenne</h2>
<p>Google et Stripe peuvent traiter des données en dehors de l'Union européenne, notamment aux États-Unis. Ils encadrent ces transferts par les garanties que le RGPD prévoit et qu'ils décrivent dans leurs propres documents contractuels (décision d'adéquation de la Commission européenne ou clauses contractuelles types, selon le cas) : reportez-vous à leurs politiques pour le détail.</p>
<p>Pays de traitement du prestataire d'envoi d'e-mails et de l'hébergeur, et garanties le cas échéant : ${todo("pays de traitement et garanties du prestataire d'e-mails et de l'hébergeur")}.</p>

<h2>5. Ce que l'extension garde sur votre appareil</h2>
<p>L'extension garde dans son stockage, sur votre appareil : votre jeton de session et l'état de votre abonnement, vos réglages, des compteurs de crédits et les résultats de vos analyses (${duration(AI_CACHE_TTL_MS)} pour un résultat). Si vous utilisez vos propres clés Google, elles y restent aussi. L'éditeur n'y a pas accès. « Me déconnecter » efface la session et l'état de l'abonnement ; désinstaller l'extension efface tout.</p>

<h2>6. Sécurité</h2>
<p>Le service n'est accessible qu'en HTTPS. Dans la base de données, les codes de connexion et les jetons de session ne sont gardés que sous forme d'empreinte, et des adresses IP il ne reste que des empreintes. Les clés Google de l'éditeur restent sur le serveur : l'extension ne les reçoit jamais.</p>

<h2>7. Vos droits</h2>
<p>Vous avez le droit d'accéder à vos données, de les faire rectifier, de les faire effacer, de les recevoir dans un format réutilisable (portabilité), de vous opposer à un traitement fondé sur l'intérêt légitime et d'en demander la limitation.</p>
<ul>
<li><strong>Effacement.</strong> Le bouton « Supprimer mon compte », dans la page d'options de l'extension, efface votre compte et l'historique de vos analyses (résiliez d'abord un abonnement en cours). Restent, pour les raisons données plus haut : vos factures chez Stripe et chez l'éditeur, l'empreinte de l'essai gratuit pendant ${duration(TRIAL_CLAIM_KEEP_MS)}, et les sauvegardes pendant ${BACKUP_KEEP_DAYS} jours au plus.</li>
<li><strong>Les autres droits.</strong> Écrivez à ${contact()}. L'éditeur répond dans un délai d'un mois. Pour votre sécurité, il peut vous demander de prouver que le compte est le vôtre, par exemple en écrivant depuis l'adresse du compte.</li>
<li><strong>Réclamation.</strong> Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir la Commission nationale de l'informatique et des libertés (CNIL) : <a href="https://www.cnil.fr" rel="noopener noreferrer">www.cnil.fr</a>.</li>
</ul>
<p>Les données demandées pour créer le compte et payer sont nécessaires au service : sans elles, il ne peut pas vous être fourni.</p>
`;
}
