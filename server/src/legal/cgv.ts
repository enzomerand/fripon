import { formatCount } from '../../../lib/format';
import { PLAN_CAPS, PRICE_SPECS, TRIAL_ANALYSES, type PlanName } from '../plans';
import { REVIEWS_PER_PHOTO } from '../quota';
import { TERMS_MESSAGE } from '../routes/billing';
import { contact, escapeHtml, euros, publisherList, todo } from './page';

/** How many days the subscribers are warned before a change of the terms takes effect. */
export const CHANGE_NOTICE_DAYS = 30;

const PLAN_LABELS: Record<PlanName, string> = { essentiel: 'Essentiel', revendeur: 'Revendeur' };

/**
 * The offers table. Every figure comes from `plans.ts` (prices, caps, trial), never retyped here:
 * the terms cannot say one thing while Checkout charges another.
 */
function offersTable(): string {
  const rows = Object.values(PRICE_SPECS)
    .map((spec) => {
      const caps = PLAN_CAPS[spec.plan];
      const label = `${PLAN_LABELS[spec.plan]} ${spec.interval === 'month' ? 'mensuel' : 'annuel'}`;
      const per = spec.interval === 'month' ? 'mois' : 'an';
      return `<tr><th scope="row">${label}</th><td>${euros(spec.amount)} TTC par ${per}</td><td>${formatCount(caps.monthCap)}</td><td>${formatCount(caps.dayCap)}</td></tr>`;
    })
    .join('\n');
  return `<div class="scroll">
<table>
<thead><tr><th scope="col">Offre</th><th scope="col">Prix</th><th scope="col">Analyses par mois</th><th scope="col">Analyses par jour</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>`;
}

/** The terms of sale and use, as the HTML of the page's body (the page around it is `legalPage`). */
export function cgvBody(serviceUrl: string): string {
  return `
<p>Ces conditions s'appliquent à Fripon Cloud, l'abonnement de l'extension de navigateur Fripon. En créant un compte ou en vous abonnant, vous les acceptez. « L'éditeur » désigne la personne identifiée à l'article 1, « vous » la personne qui utilise Fripon Cloud.</p>

<h2>1. Éditeur et mentions légales</h2>
${publisherList(serviceUrl)}

<h2>2. Le service</h2>
<p>Fripon est une extension de navigateur libre (licence AGPL-3.0, code source public) qui signale, sur les pages de Vinted, les annonces qui paraissent revendues depuis Shein, Temu, AliExpress et consorts (dropshipping) ou affichées à un prix gonflé. Ses vérifications simples se font dans votre navigateur. Deux étapes demandent un service payant : la recherche d'image (Google Cloud Vision) et l'avis de l'IA (Gemini de Google avec vos propres clés ; Claude d'Anthropic dans l'abonnement).</p>
<p>Fripon Cloud est l'abonnement qui fait fonctionner ces deux étapes avec les clés de l'éditeur (Google pour la recherche d'image, Anthropic pour l'avis de l'IA), sans que vous ayez à créer les vôtres, dans la limite des analyses prévues par votre offre. (L'extension fonctionne aussi sans abonnement, avec vos propres clés Google : ces conditions ne s'appliquent alors pas.)</p>
<p>Les résultats sont des indications fondées sur des recoupements automatiques : une photo retrouvée sur d'autres sites, des indices calculés, l'avis d'une intelligence artificielle. Ils ne garantissent ni qu'une annonce est honnête ou conforme, ni qu'elle ne l'est pas, ni la fiabilité d'un vendeur. Ils peuvent être faux dans un sens comme dans l'autre. Vous restez seul juge de ce que vous achetez ou vendez.</p>
<p>Fripon n'est pas affilié à Vinted, ni approuvé ou soutenu par Vinted.</p>

<h2>3. Compte et usage</h2>
<p>Vous vous connectez avec votre adresse e-mail et un code à usage unique reçu par e-mail : il n'y a pas de mot de passe. Vous êtes responsable de l'accès à votre boîte e-mail. Un compte est personnel.</p>
<p>Vous utilisez le service depuis l'extension, pour vos propres analyses. Vous vous interdisez d'envoyer des demandes en masse par un moyen automatisé et de contourner les plafonds ou l'essai gratuit. En cas d'abus manifeste, l'éditeur peut limiter ou suspendre l'accès au compte.</p>

<h2>4. Offres et prix</h2>
<p>Fripon Cloud propose deux offres payantes et un essai gratuit. Les prix sont en euros, toutes taxes comprises (TTC), tels qu'ils sont affichés dans l'extension et sur la page de paiement au moment où vous vous abonnez.</p>
${offersTable()}
<p>L'offre annuelle donne droit aux mêmes plafonds que l'offre mensuelle : les analyses se comptent mois par mois.</p>
<p><strong>Essai gratuit :</strong> ${formatCount(TRIAL_ANALYSES)} analyses au total, sans carte bancaire, une seule fois par boîte e-mail (même si vous supprimez votre compte puis en créez un nouveau). L'essai ne se renouvelle pas.</p>
<p>Les plafonds se comptent sur le calendrier français : le mois civil et le jour civil, à l'heure de Paris. Les analyses non utilisées ne sont pas reportées sur la période suivante.</p>

<h2>5. Ce qu'est une analyse</h2>
<ul>
<li>Une analyse, c'est la première recherche d'image d'une annonce (reconnue à sa photo) au cours d'un mois civil, heure de Paris.</li>
<li>Analyser de nouveau la même annonce le même mois est gratuit, même si votre plafond est atteint.</li>
<li>L'avis de l'IA est inclus dans l'analyse de l'annonce, sans décompte en plus, dans la limite de ${REVIEWS_PER_PHOTO} avis par annonce et par mois.</li>
<li>Quand un plafond (mensuel ou journalier) est atteint, l'analyse d'une nouvelle annonce est refusée jusqu'à la période suivante.</li>
<li>Une analyse qui échoue n'est en général pas décomptée. Quand le prestataire a pu traiter la demande avant l'échec (délai dépassé, par exemple), elle peut l'être.</li>
</ul>

<h2>6. Paiement, renouvellement et factures</h2>
<ul>
<li>Le paiement est traité par Stripe, prestataire de paiement, avec les moyens de paiement qu'il propose au moment de l'achat. L'éditeur ne voit ni ne conserve votre numéro de carte.</li>
<li>L'abonnement est pris pour un mois ou pour un an, selon l'offre. Il se renouvelle automatiquement, pour la même durée et au même prix (sauf modification annoncée selon l'article 13), jusqu'à ce que vous le résiliez. Le paiement est prélevé à chaque échéance.</li>
<li>Si un paiement échoue, Stripe le retente pendant quelques jours et l'accès au service est maintenu pendant ce délai. Si le paiement n'aboutit jamais, l'abonnement prend fin. Vous pouvez mettre votre carte à jour depuis « Gérer mon abonnement ».</li>
<li>Vous pouvez changer d'offre depuis « Gérer mon abonnement » ; Stripe calcule alors l'ajustement au prorata de ce que vous avez déjà payé.</li>
<li>Vos factures sont consultables depuis « Gérer mon abonnement ».</li>
</ul>

<h2>7. Résiliation</h2>
<p>Vous pouvez résilier à tout moment, sans motif et sans frais : ouvrez la page d'options de l'extension, section « Abonnement Fripon », puis « Gérer mon abonnement ».</p>
<p>La résiliation prend effet à la fin de la période déjà payée : vous gardez l'accès jusqu'à cette date et il n'y a plus de prélèvement ensuite. Une période commencée n'est pas remboursée, sauf lorsque la loi l'impose.</p>

<h2>8. Droit de rétractation</h2>
<p>Si vous agissez en tant que consommateur (à des fins qui n'entrent pas dans le cadre de votre activité professionnelle), vous disposez en principe de 14 jours pour vous rétracter d'un contrat conclu à distance.</p>
<p>Fripon Cloud est un service numérique fourni dès le paiement. Conformément à l'article L221-28, 13° du Code de la consommation, le droit de rétractation ne peut pas être exercé pour un contenu numérique fourni sans support matériel dont l'exécution a commencé avec votre accord préalable exprès et votre renoncement exprès à ce droit.</p>
<p>C'est pourquoi la page de paiement Stripe vous demande, avant de payer, de cocher la case suivante : « ${escapeHtml(TERMS_MESSAGE)} ». Sans cette case cochée, le paiement ne peut pas être fait. L'essai gratuit n'implique ni paiement ni renonciation.</p>

<h2>9. Disponibilité du service</h2>
<p>Fripon Cloud est fourni au mieux de ce que l'éditeur peut faire, sans garantie de disponibilité continue. Il dépend de prestataires (Google, Anthropic, Stripe, l'hébergeur, l'envoi d'e-mails) et des pages de Vinted, dont la structure peut changer sans préavis. Il peut être interrompu pour une maintenance ou un incident, ou limité par des plafonds de capacité, ceux de l'éditeur comme ceux de ses prestataires. Une analyse refusée pour l'une de ces raisons n'est en général pas décomptée.</p>
<p>L'éditeur peut faire évoluer le service ou l'arrêter. S'il l'arrête, plus aucun renouvellement n'est prélevé. Cela ne limite pas les droits que la loi vous reconnaît.</p>

<h2>10. Responsabilité</h2>
<p>L'éditeur fournit le service avec le soin d'un professionnel diligent (obligation de moyens), sans garantir de résultat. Il n'est pas responsable des décisions que vous prenez à partir des analyses (acheter, ne pas acheter, vendre, signaler), ni du contenu des annonces, ni du comportement des vendeurs ou des acheteurs.</p>
<p>Aucune disposition de ces conditions n'exclut ni ne limite les droits que la loi vous reconnaît en tant que consommateur, notamment les garanties légales applicables aux contenus et aux services numériques, ni la responsabilité de l'éditeur en cas de dommage corporel, de faute lourde ou de dol.</p>

<h2>11. Suppression du compte</h2>
<p>Vous pouvez supprimer votre compte à tout moment depuis la page d'options de l'extension, bouton « Supprimer mon compte ». Tant qu'un abonnement est en cours ou peut encore être facturé, la suppression est refusée : résiliez d'abord, puis supprimez votre compte une fois la période payée terminée.</p>
<p>La suppression efface votre compte, vos sessions et l'historique de vos analyses. Votre client Stripe et vos factures restent chez Stripe, et chez l'éditeur pour la durée légale de conservation des documents comptables. Une empreinte de votre adresse e-mail reste enregistrée pour qu'un essai gratuit ne serve qu'une fois : voir la <a href="/confidentialite">politique de confidentialité</a>.</p>

<h2>12. Données personnelles</h2>
<p>Les données personnelles sont traitées comme l'explique la <a href="/confidentialite">politique de confidentialité</a>.</p>

<h2>13. Modification des conditions</h2>
<p>L'éditeur peut modifier ces conditions, par exemple quand le service ou la loi évolue. Les abonnés sont prévenus par e-mail, à l'adresse de leur compte, au moins ${CHANGE_NOTICE_DAYS} jours avant l'entrée en vigueur de la modification. Si vous la refusez, vous pouvez résilier avant cette date ; si vous gardez votre abonnement après cette date, la modification s'applique à vous. Une modification ne s'applique jamais à une période déjà payée, et un changement de prix ne vaut qu'à partir du renouvellement suivant.</p>

<h2>14. Droit applicable, litiges et médiation</h2>
<p>Ces conditions sont soumises au droit français. Si vous êtes consommateur, vous pouvez saisir la juridiction du lieu où vous demeurez, dans les conditions prévues par la loi.</p>
<p>Avant toute action, écrivez à l'éditeur (${contact()}) : la plupart des difficultés se règlent ainsi. Si vous êtes consommateur et que le litige n'est pas réglé, vous avez le droit de recourir gratuitement à un médiateur de la consommation. Médiateur de la consommation de l'éditeur : ${todo('nom, adresse postale et site internet du médiateur de la consommation')}.</p>
`;
}
