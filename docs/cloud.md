# Fripon Cloud : déploiement

Fripon Cloud est le serveur d'abonnement de l'extension (`server/`). Un abonné se connecte par un code reçu par mail, paie via Stripe, et son extension passe par ce serveur pour la recherche d'image (Google Vision) et l'avis IA (Gemini) avec **tes** clés Google, dans la limite de ses quotas. Une base SQLite (comptes, quotas, cache partagé) vit dans un volume Docker. Les mots de passe n'existent pas, les clés Google ne quittent jamais le serveur.

## Prérequis

**Docker.** Docker Compose **2.30 ou plus récent** (`docker compose version`) : `compose.yml` lit `server/.env` avec `env_file` en `format: raw` (un `$` dans un mot de passe reste un `$`), ce que les versions plus anciennes refusent. L'image part d'une version **exacte** de Node (`node:22.x.y-bookworm-slim` dans `server/Dockerfile`) : une reconstruction ne change pas le runtime toute seule. Pour la monter, remplace les deux `FROM` par la dernière 22.x de [nodejs.org](https://nodejs.org/en/about/previous-releases) (vérifie que le tag existe sur Docker Hub), puis reconstruis.

**Google.** Deux clés distinctes, chacune **restreinte à son API** (Cloud Vision API pour l'une, Generative Language API pour l'autre), si possible aussi à l'IP du VPS.

- Clé Vision : projet Google Cloud **avec facturation**, API Cloud Vision activée.
- Clé Gemini : projet **avec facturation aussi**. Les conditions de l'API Gemini exigent un service payant pour les utilisateurs de l'EEE, alors que la clé gratuite du mode « ta propre clé » ne convient pas ici.
- Plafonne la dépense côté Google : un quota journalier de requêtes sur l'API Vision (Quotas et limites système) et une alerte de budget (Facturation, Budgets et alertes). `GLOBAL_DAILY_VISION_CAP` (3 000 par jour) et `GLOBAL_DAILY_GEMINI_CAP` (5 000 par jour) sont un second garde-fou, côté serveur : au-delà, les abonnés reçoivent « capacité atteinte » jusqu'à la journée suivante. Les essais gratuits n'ont droit qu'à 20 % du plafond Vision de la journée (600 appels par défaut) : un essai de plus reçoit « capacité atteinte » alors que les abonnés passent encore.
- Les deux plafonds comptent sur le jour de Google (minuit, heure du Pacifique), comme ses quotas, alors que les quotas des abonnés comptent sur les jours de Paris. **Le premier jour après un déploiement**, le compteur repart de zéro alors que Google a pu déjà servir des appels depuis minuit Pacifique : le plafond peut sous-compter de quelques heures. C'est sans conséquence (le quota Google et l'alerte de budget restent le vrai garde-fou), il n'y a rien à corriger.

**Stripe.** Commence en mode test.

1. Mets `STRIPE_SECRET_KEY=sk_test_...` dans `server/.env` sur ton Mac, puis `npm --prefix server install` et `npm --prefix server run stripe:setup`. Le script crée un produit par offre (« Fripon Essentiel » et « Fripon Revendeur », ceux que le portail et les factures affichent), les trois prix (`PRICE_SPECS` dans `server/src/plans.ts`, TTC : les CGV servies par le serveur les lisent au même endroit) et le portail client ; il peut être relancé sans rien dupliquer. **Chaque produit et chaque prix porte `metadata.plan`** (`essentiel` ou `revendeur`) : c'est ce que le serveur lit pour savoir à quelle offre est un abonné, et non la clé de recherche (`lookup_key`), qui change de prix quand tu modifies un tarif. Le script ajoute cette étiquette aux produits et aux prix qu'il trouve sans elle, et au prix dont il déplace la clé. Il affiche un `bpc_...` : à mettre dans `STRIPE_PORTAL_CONFIGURATION` seulement si le portail se plaint de ne pas avoir de configuration par défaut. Si un ancien produit unique « Fripon » existe déjà (test fait avec une version précédente du script), le script n'y touche pas : il crée les deux nouveaux produits et y déplace les prix ; archive l'ancien dans le Dashboard quand plus personne n'y est abonné. Après une mise à jour du script, relance-le, puis `stripe:resync` (voir plus bas).
2. Webhook : `npm --prefix server run stripe:setup -- --webhook https://fripon.endurance.tools/v1/stripe/webhook` le crée et affiche son secret `whsec_...` **une seule fois** (pour `STRIPE_WEBHOOK_SECRET`). À la main dans le Dashboard, c'est la même URL avec cinq événements : `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` et `charge.dispute.created`. Ce dernier ne fait que te prévenir par mail (un litige se répond dans le Dashboard, dans un délai) : rien n'est résilié ni remboursé automatiquement.
3. Conditions d'utilisation : l'URL à renseigner est `https://fripon.endurance.tools/cgv` (les CGV servies par le serveur, voir « Pages légales » plus bas), dans le Dashboard Stripe (Settings > Public details, « Conditions d'utilisation » ; mets aussi `https://fripon.endurance.tools/confidentialite` dans le champ de la politique de confidentialité), **avant** de passer `STRIPE_REQUIRE_TERMS=true`. **C'est obligatoire avant de passer en production** : le service démarre tout de suite et le droit de rétractation de 14 jours est écarté, ce qui n'est valable que si l'acheteur le coche à l'achat. Sans l'URL dans le Dashboard, Checkout refuse de se créer ; en test, tu peux laisser `false`.
4. Passage en production : clé `sk_live_...`, `stripe:setup -- --live --webhook <url>` (les webhooks sont propres à chaque mode : nouveau `whsec_...`), `STRIPE_REQUIRE_TERMS=true`, puis mets le `.env` à jour et recrée le conteneur (voir plus bas). **Nettoie les données du mode test** : les clients Stripe créés en test n'existent pas en mode live. Un compte qui en porte un le découvre à sa prochaine demande d'abonnement (Stripe répond « No such customer ») : le serveur efface alors ce que le compte sait de Stripe (client, abonnement, offre, statut) et recrée un client, sans rien dire à l'utilisateur. Si tu préfères le faire une fois pour toutes avant d'ouvrir (sur le VPS, depuis `/opt/fripon-cloud`, après une sauvegarde) :

   ```sh
   docker compose -f server/compose.yml exec -T fripon-cloud node -e "const db=require('better-sqlite3')('/data/fripon.db');console.log(db.prepare('UPDATE accounts SET stripe_customer_id=NULL, subscription_id=NULL, plan=NULL, subscription_status=NULL, period_end=NULL WHERE stripe_customer_id IS NOT NULL OR subscription_id IS NOT NULL').run().changes+' comptes remis à zéro');db.close()"
   ```

   Archive aussi, dans le Dashboard **test**, les produits, prix et l'endpoint webhook qui ne servent plus.

**Pages légales.** Le serveur sert deux pages statiques : `GET /cgv` (conditions générales de vente et d'utilisation) et `GET /confidentialite` (politique de confidentialité), liées depuis la section « Abonnement Fripon » de la page d'options. Ce sont des **brouillons**, pas des conseils juridiques : ils partent de ce que fait le code (les offres, les plafonds et les durées de conservation sont lus dans ses constantes, `plans.ts`, `auth.ts`, `routes/proxy.ts`) et sont à faire relire. Tant que `LEGAL_PAGES_FINAL` n'est pas `true`, chaque page affiche « Brouillon à faire relire — ne pas publier en l'état » et demande aux moteurs de recherche de l'ignorer. **Avant de passer `LEGAL_PAGES_FINAL=true`** : remplis chaque `[À COMPLÉTER : …]` (éditeur et statut, adresse, SIRET, TVA, directeur de la publication, contact, hébergeur, prestataire d'e-mails, pays de traitement, médiateur de la consommation) dans `server/src/legal/` (`grep -rn "À COMPLÉTER" server/src/legal` les liste, et le serveur avertit dans ses logs s'il en reste une page marquée finale), fais relire les deux textes, et mets `LEGAL_VERSION_DATE` (`server/src/legal/page.ts`) à la date de la version publiée. Deux durées vivent hors du code (journaux de Caddy, 7 jours ; sauvegardes, 30 jours) : un test les compare au Caddyfile et à ce document, change-les ensemble. Une modification des conditions se notifie par e-mail aux abonnés 30 jours avant son entrée en vigueur : rien dans le serveur ne l'envoie, c'est à faire à la main.

**SMTP.** Un serveur qui envoie le code de connexion (`SMTP_URL`, `MAIL_FROM`) et les alertes (`OWNER_EMAIL`, voir « Surveillance »). Le domaine de l'expéditeur doit avoir SPF et DKIM, sinon les codes finissent en spam. Les caractères spéciaux de l'identifiant et du mot de passe s'encodent dans l'URL (`@` donne `%40`).

**DNS.** Un enregistrement A (et AAAA si le VPS a de l'IPv6) `fripon.endurance.tools` vers l'IP du VPS. Si le domaine passe par Cloudflare, laisse-le en DNS seul (nuage gris) : sinon le serveur voit les IP de Cloudflare au lieu de celles des clients et ses limites par IP ne servent plus à rien.

**Le domaine est à figer avant de publier l'extension.** L'extension publiée porte le domaine dans son manifeste : le changer ensuite oblige à republier (et à attendre la validation des stores), et les installations déjà faites ne le suivent pas. Il est écrit à **cinq** endroits, à garder identiques :

1. `CLOUD_ORIGIN` dans `lib/cloud/config.ts` (toutes les requêtes de l'extension partent de là) ;
2. la permission d'hôte du manifeste généré (`${CLOUD_ORIGIN}/*` dans `wxt.config.ts` : elle suit le point 1 au prochain `npm run build`) ;
3. `PUBLIC_URL` dans `server/.env` (où Stripe renvoie l'acheteur après le paiement) ;
4. le nom du site dans le bloc Caddy (`server/caddy/fripon.caddy`) ;
5. l'URL de l'endpoint webhook dans Stripe (`stripe:setup -- --webhook <url>` en crée un nouveau ; supprime l'ancien).

`docs/safari.md` cite aussi le nom dans le texte qui explique les autorisations de Safari : à relire avec les cinq autres.

## Premier déploiement

Sur le VPS (en root, ou avec `sudo` là où `/opt` l'exige) :

1. `git clone https://github.com/enzomerand/fripon.git /opt/fripon-cloud`, puis `cd /opt/fripon-cloud`.
2. `cp server/.env.example server/.env && chmod 600 server/.env`, puis remplis-le (`openssl rand -hex 32` pour `AUTH_SECRET`). Le serveur refuse de démarrer tant qu'une variable obligatoire manque, et les liste toutes dans ses logs. Deux sont à dire explicitement, sans valeur par défaut en production : `OWNER_EMAIL` (l'adresse qui reçoit les alertes) et `TRUST_PROXY`. Mets `TRUST_PROXY=true` : Caddy est devant l'app, et c'est à cette condition que le serveur lit l'IP du client dans `X-Forwarded-For` (limites par IP, plafond de trois comptes par IP et par jour). `false` n'est juste que sans proxy devant, où un client pourrait écrire l'IP qu'il veut ; une IPv6 compte pour son préfixe /64 (un abonné en possède des milliards), une IPv4 mappée en IPv6 pour son IPv4.
   **Raccourci :** une fois `AUTH_SECRET`, `PUBLIC_URL` et `TRUST_PROXY` posés, `ssh -t vps /opt/fripon-cloud/server/scripts/configure.sh` demande les autres secrets (saisie masquée, rien n'est affiché), lance `stripe-setup` dans l'image avec le webhook de `PUBLIC_URL`, range seul le `whsec_...` et le `bpc_...`, puis dit ce qui manque. Il se relance sans rien perdre (Entrée garde une valeur) ; il n'accepte qu'une clé Stripe de test.
3. `docker compose -f server/compose.yml up -d --build`. Ça crée le réseau `friponnet` et le volume `fripon-cloud-data`. Vérifie : `docker compose -f server/compose.yml ps` (état `healthy`) et `... logs fripon-cloud`.
4. Caddy : ajoute le bloc de `server/caddy/fripon.caddy` à `/opt/reverse-proxy/Caddyfile`, et les lignes du réseau externe `friponnet` (expliquées en tête de ce fichier) au compose de `/opt/reverse-proxy`, puis `docker compose up -d` dans ce dossier.
5. Vérifie puis recharge Caddy : `docker compose -f /opt/reverse-proxy/compose.yml exec caddy caddy validate --config /etc/caddy/Caddyfile`, puis la même commande avec `reload` (adapte le chemin si le Caddyfile est monté ailleurs). Le certificat HTTPS est obtenu tout seul, une fois le DNS en place.
6. Teste : `curl https://fripon.endurance.tools/healthz` répond `{"ok":true}`. Pour le mail : `curl -X POST https://fripon.endurance.tools/v1/auth/code -H 'content-type: application/json' -d '{"email":"toi@exemple.fr"}'` répond 204 et le code arrive.
7. **Teste le téléchargement d'une photo Vinted depuis le VPS** : le serveur télécharge lui-même la photo avant de l'envoyer à Google, et Vinted peut refuser une IP de datacenter. Prends l'adresse d'une photo d'annonce (clic droit sur la photo, copier l'adresse de l'image, elle est sur `images1.vinted.net`) et lance, **depuis le VPS** : `curl -s -o /dev/null -w '%{http_code}\n' '<adresse de la photo>'`. Il doit répondre `200`. Il a répondu `200` le 2026-10-27 ; si c'est un `403`, les analyses échoueront toutes en « photo » : change d'hébergeur ou de sortie réseau avant d'ouvrir. Refais ce test de temps en temps.

Un changement du `.env` demande `docker compose -f server/compose.yml up -d --force-recreate` : un simple `restart` ne le relit pas.

À l'arrêt, le serveur laisse jusqu'à **45 secondes** aux requêtes en cours (un appel Vision ou Gemini peut en prendre 30) avant de quitter ; `stop_grace_period: 50s` dans `compose.yml` laisse à Docker cinq secondes de plus. Garde cet écart si tu changes l'un des deux.

## Surveillance

**Alertes par mail.** Le serveur écrit à `OWNER_EMAIL` quand quelque chose ne peut être réglé que par toi : un mail en texte brut, **au plus un par type et par heure** (en mémoire : un redémarrage peut en renvoyer un), sans clé, sans jeton et sans adresse de photo complète. Les types :

| Objet du mail                            | Quand                                                                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google-vision-key`, `google-gemini-key` | Google refuse la clé du serveur (clé invalide, restreinte, API désactivée), le projet n'a plus de facturation, un quota est atteint ou le modèle n'existe plus. Les abonnés reçoivent « indisponible » tant que ce n'est pas réglé. |
| `double-subscription`                    | Un compte a deux abonnements actifs : il est débité deux fois. Annule ou rembourse l'un des deux dans le Dashboard (le serveur ne résilie rien).                                                                                    |
| `webhook-failure`                        | Un événement Stripe n'a pas pu être traité (Stripe le rejoue pendant quelques jours). Si la cause persiste, règle-la puis lance `stripe:resync`.                                                                                    |
| `dispute`                                | Un client conteste un paiement (`charge.dispute.created`) : réponds dans le Dashboard avant l'échéance.                                                                                                                             |
| `vision-ceiling`, `gemini-ceiling`       | Le plafond journalier global est atteint (usage réel, ou abus : regarde avant de le relever).                                                                                                                                       |

**Sonde externe.** `GET /healthz` répond `200 {"ok":true}` quand tout va bien, et **503** dans deux cas : la base ne répond pas (`{"ok":false}`), ou la clé Google du serveur a été refusée au cours des **10 dernières minutes** (`{"ok":false,"degraded":["vision"]}`, ou `"gemini"`). Branche n'importe quel service de surveillance de disponibilité (UptimeRobot, Better Stack, Uptime Kuma sur un autre serveur...) sur `https://fripon.endurance.tools/healthz`, intervalle de 1 à 5 minutes, alerte sur tout code autre que 200 : c'est ce qui te prévient aussi quand le serveur ou le VPS est tombé, ce qu'un mail du serveur ne peut pas faire. La sonde Docker du conteneur (`healthy`) lit la même adresse : elle passe `unhealthy` pendant un problème de clé, sans redémarrer le conteneur.

**Resynchroniser Stripe.** La base suit Stripe par ses événements, et la lecture d'un abonnement est refaite à chaque événement. Trois filets autour : (1) quand un compte demande un abonnement et que Stripe en a déjà un vivant que la base ne connaît pas, il est enregistré ; (2) quand un compte dont l'abonnement paraît périmé (période passée, statut qui n'est plus actif, offre inconnue) appelle `/v1/me`, ou se ferait refuser une recherche pour « abonnement terminé », le serveur relit l'abonnement chez Stripe (au plus une fois toutes les 10 minutes par compte) et répond d'après l'état frais ; (3) à la main, pour tous les comptes : `docker compose -f server/compose.yml exec -T fripon-cloud node dist/stripe-resync.js` (ou `npm --prefix server run stripe:resync` en développement, avec le même `.env`). Il relit l'abonnement de chaque compte qui en a un et n'affiche que des nombres (comptes, synchronisés, remis à zéro parce que Stripe ne connaît plus l'abonnement, échecs). À lancer après une panne du webhook, un changement de prix ou de clés Stripe, ou une relance de `stripe:setup`.

## Données personnelles

La base contient des adresses mail (comptes, codes de connexion), des empreintes d'adresses IP (un hachage à clé, jamais l'adresse, gardé 24 heures) et des empreintes d'adresses mail (`trial_claims`, voir plus bas). Les logs de Caddy, eux, contiennent l'adresse IP tronquée (voir plus bas) : le texte de confidentialité de l'extension et du README le dit tel quel.

- Le serveur purge toutes les heures : codes de connexion une fois leur fenêtre de 15 minutes finie, essais de code et comptages d'IP au bout de 24 heures, sessions inutilisées depuis 90 jours **ou vieilles d'un an** (même utilisées chaque jour), événements Stripe au bout de 30 jours, les compteurs d'usage et d'avis IA **plus vieux que le mois précédent** (heure de Paris), et les empreintes d'essai gratuit au bout de 12 mois.
- `DELETE /v1/account` (jeton de l'abonné) supprime le compte, ses sessions, son usage, ses avis, son code de connexion et ses essais de code. Il répond 409 `active_subscription` tant que Stripe facture (ou peut encore facturer) un abonnement : actif, en essai, en impayé, ou un premier paiement `incomplete` (Stripe est interrogé, pas seulement la base : elle n'est à jour qu'au dernier webhook) ; si Stripe ne répond pas, 503 `unavailable` et rien n'est supprimé. L'abonné résilie d'abord dans le portail. Le client Stripe et ses factures **restent chez Stripe** (la loi impose de les garder) ; la base n'en garde aucune trace. Un abonné qui revient avec la même adresse crée un nouveau compte, **sans nouvel essai gratuit** : `trial_claims` garde, 12 mois, un hachage à clé (`AUTH_SECRET`) de l'adresse canonique (jamais l'adresse) écrit quand un compte est créé avec l'essai, et `DELETE /v1/account` n'y touche pas. Changer `AUTH_SECRET` rend ces empreintes illisibles (l'essai est de nouveau possible).
- Les logs de Caddy (`/var/log/caddy/fripon.log`) gardent l'IP des clients **tronquée** (`ip_mask`, /24 en IPv4 et /48 en IPv6), n'ont ni `Authorization` ni `X-Forwarded-For` ni chaîne de requête, et sont gardés **7 jours** (`roll_keep_for 168h`) ; l'application, elle, ne garde de l'adresse complète qu'un hachage pendant 24 heures.

## Mise à jour

```sh
cd /opt/fripon-cloud && git pull
docker compose -f server/compose.yml up -d --build
docker image prune -f
```

Le schéma de la base se migre tout seul au démarrage. Sauvegarde avant une mise à jour qui touche `server/src/db.ts`.

## Sauvegarde

L'image n'a pas de client `sqlite3` : on utilise l'API de sauvegarde de better-sqlite3, qui copie la base à chaud de façon cohérente (la base est en mode WAL : copier `fripon.db` seul pendant que le serveur tourne donnerait une copie incomplète).

```sh
mkdir -p -m 700 /var/backups/fripon-cloud
docker compose -f server/compose.yml exec -T fripon-cloud node -e "const db=require('better-sqlite3')('/data/fripon.db');db.backup('/data/backup.db').then(()=>db.close())"
docker cp fripon-cloud:/data/backup.db /var/backups/fripon-cloud/fripon-$(date +%F).db
docker compose -f server/compose.yml exec -T fripon-cloud rm /data/backup.db
find /var/backups/fripon-cloud -name 'fripon-*.db' -mtime +30 -delete
```

Lance-les depuis `/opt/fripon-cloud`, dans un cron quotidien, et copie `/var/backups/fripon-cloud` **hors du VPS** (la base contient des adresses mail). La dernière commande est la rotation : **les sauvegardes sont gardées 30 jours**, pas plus (une sauvegarde plus ancienne ressusciterait des comptes supprimés depuis). Applique la même durée à la copie hors du VPS. Autre solution, serveur arrêté : `docker compose -f server/compose.yml down`, copie le contenu du volume (`/var/lib/docker/volumes/fripon-cloud-data/_data`, avec les fichiers `-wal` et `-shm` s'ils existent), puis `up -d`. Pour restaurer : arrête l'app, remplace `fripon.db` dans le volume par la sauvegarde (et supprime les `-wal` et `-shm`), relance. Après une restauration, lance `stripe:resync` : la base reprend l'état de Stripe pour les abonnements, et un compte supprimé depuis la sauvegarde est de retour (supprime-le à nouveau s'il l'avait demandé).

## Retour arrière

1. Si des abonnements existent, annule-les (ou rembourse-les) dans Stripe **d'abord** : sinon Stripe continue de facturer un service éteint.
2. `docker compose -f server/compose.yml down` arrête tout et garde le volume (`down -v` efface la base : à ne faire qu'après sauvegarde).
3. Retire le bloc de `/opt/reverse-proxy/Caddyfile` et le réseau `friponnet` du compose de Caddy, puis recharge Caddy.
4. Dans Stripe, archive les trois prix et les deux produits, et désactive l'endpoint webhook.

**Côté utilisateurs :** ceux qui sont connectés à Fripon Cloud restent sans étapes payantes (recherche d'image, avis IA) tant qu'ils ne se sont pas déconnectés : l'extension ne sait pas que le serveur n'existe plus, et chaque analyse échoue. Une fois déconnectés (bouton « Me déconnecter » de la page d'options), ils retrouvent le mode « ma propre clé » et peuvent y mettre leurs clés Google. Prévois de le leur dire (page de présentation, note de version) avant d'éteindre.

## Développement en local

`npm --prefix server install`, puis `npm --prefix server run dev` : esbuild en watch et `node --watch`, sur `http://localhost:8787`. `npm run dev` lance le serveur avec `NODE_ENV=development` (sans `NODE_ENV`, le serveur se croit en production et exige toute la configuration, ce qui évite qu'un oubli ne le mette en mode développement) : sans `server/.env`, le code de connexion s'affiche dans la console à la place d'un mail (n'ajoute pas `SMTP_URL`), les alertes aussi (pas d'`OWNER_EMAIL`), et les clés Google restent vides. Pour tester Stripe, mets une clé `sk_test_...` dans `server/.env` et relaie les événements avec `stripe listen --forward-to localhost:8787/v1/stripe/webhook` (il affiche le `whsec_...` à utiliser). Les tests : `npm --prefix server test`.
