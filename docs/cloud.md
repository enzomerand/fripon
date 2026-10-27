# Fripon Cloud : déploiement

Fripon Cloud est le serveur d'abonnement de l'extension (`server/`). Un abonné se connecte par un code reçu par mail, paie via Stripe, et son extension passe par ce serveur pour la recherche d'image (Google Vision) et l'avis IA (Gemini) avec **tes** clés Google, dans la limite de ses quotas. Une base SQLite (comptes, quotas, cache partagé) vit dans un volume Docker. Les mots de passe n'existent pas, les clés Google ne quittent jamais le serveur.

## Prérequis

**Google.** Deux clés distinctes, chacune **restreinte à son API** (Cloud Vision API pour l'une, Generative Language API pour l'autre), si possible aussi à l'IP du VPS.

- Clé Vision : projet Google Cloud **avec facturation**, API Cloud Vision activée.
- Clé Gemini : projet **avec facturation aussi**. Les conditions de l'API Gemini exigent un service payant pour les utilisateurs de l'EEE, alors que la clé gratuite du mode « ta propre clé » ne convient pas ici.
- Plafonne la dépense côté Google : un quota journalier de requêtes sur l'API Vision (Quotas et limites système) et une alerte de budget (Facturation, Budgets et alertes). `GLOBAL_DAILY_VISION_CAP` est un second garde-fou, côté serveur.

**Stripe.** Commence en mode test.

1. Mets `STRIPE_SECRET_KEY=sk_test_...` dans `server/.env` sur ton Mac, puis `npm --prefix server install` et `npm --prefix server run stripe:setup`. Le script crée le produit « Fripon », les trois prix (`PRICE_SPECS` dans `server/src/stripe-setup.ts`, TTC) et le portail client ; il peut être relancé sans rien dupliquer. Il affiche un `bpc_...` : à mettre dans `STRIPE_PORTAL_CONFIGURATION` seulement si le portail se plaint de ne pas avoir de configuration par défaut.
2. Webhook : `npm --prefix server run stripe:setup -- --webhook https://fripon.endurance.tools/v1/stripe/webhook` le crée et affiche son secret `whsec_...` **une seule fois** (pour `STRIPE_WEBHOOK_SECRET`). À la main dans le Dashboard, c'est la même URL avec quatre événements : `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
3. Conditions d'utilisation : renseigne leur URL dans le Dashboard Stripe (paramètres, informations publiques) **avant** de passer `STRIPE_REQUIRE_TERMS=true`, sinon Checkout refuse de se créer.
4. Passage en production : clé `sk_live_...`, `stripe:setup -- --live --webhook <url>` (les webhooks sont propres à chaque mode : nouveau `whsec_...`), puis mets le `.env` à jour et recrée le conteneur (voir plus bas).

**SMTP.** Un serveur qui envoie le code de connexion (`SMTP_URL`, `MAIL_FROM`). Le domaine de l'expéditeur doit avoir SPF et DKIM, sinon les codes finissent en spam. Les caractères spéciaux de l'identifiant et du mot de passe s'encodent dans l'URL (`@` donne `%40`).

**DNS.** Un enregistrement A (et AAAA si le VPS a de l'IPv6) `fripon.endurance.tools` vers l'IP du VPS. Si le domaine passe par Cloudflare, laisse-le en DNS seul (nuage gris) : sinon le serveur voit les IP de Cloudflare au lieu de celles des clients et ses limites par IP ne servent plus à rien.

Le domaine n'est pas définitif : il se change à trois endroits (`PUBLIC_URL` dans `server/.env`, le nom du site dans le bloc Caddy, l'URL du webhook Stripe).

## Premier déploiement

Sur le VPS (en root, ou avec `sudo` là où `/opt` l'exige) :

1. `git clone https://github.com/enzomerand/fripon.git /opt/fripon-cloud`, puis `cd /opt/fripon-cloud`.
2. `cp server/.env.example server/.env && chmod 600 server/.env`, puis remplis-le (`openssl rand -hex 32` pour `AUTH_SECRET`). Le serveur refuse de démarrer tant qu'une variable obligatoire manque, et les liste toutes dans ses logs.
3. `docker compose -f server/compose.yml up -d --build`. Ça crée le réseau `friponnet` et le volume `fripon-cloud-data`. Vérifie : `docker compose -f server/compose.yml ps` (état `healthy`) et `... logs fripon-cloud`.
4. Caddy : ajoute le bloc de `server/caddy/fripon.caddy` à `/opt/reverse-proxy/Caddyfile`, et les lignes du réseau externe `friponnet` (expliquées en tête de ce fichier) au compose de `/opt/reverse-proxy`, puis `docker compose up -d` dans ce dossier.
5. Vérifie puis recharge Caddy : `docker compose -f /opt/reverse-proxy/compose.yml exec caddy caddy validate --config /etc/caddy/Caddyfile`, puis la même commande avec `reload` (adapte le chemin si le Caddyfile est monté ailleurs). Le certificat HTTPS est obtenu tout seul, une fois le DNS en place.
6. Teste : `curl https://fripon.endurance.tools/healthz` répond `{"ok":true}`. Pour le mail : `curl -X POST https://fripon.endurance.tools/v1/auth/code -H 'content-type: application/json' -d '{"email":"toi@exemple.fr"}'` répond 204 et le code arrive.

Un changement du `.env` demande `docker compose -f server/compose.yml up -d --force-recreate` : un simple `restart` ne le relit pas.

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
```

Lance-les depuis `/opt/fripon-cloud`, dans un cron quotidien, et copie `/var/backups/fripon-cloud` **hors du VPS** (la base contient des adresses mail). Autre solution, serveur arrêté : `docker compose -f server/compose.yml down`, copie le contenu du volume (`/var/lib/docker/volumes/fripon-cloud-data/_data`, avec les fichiers `-wal` et `-shm` s'ils existent), puis `up -d`. Pour restaurer : arrête l'app, remplace `fripon.db` dans le volume par la sauvegarde (et supprime les `-wal` et `-shm`), relance.

## Retour arrière

1. Si des abonnements existent, annule-les (ou rembourse-les) dans Stripe **d'abord** : sinon Stripe continue de facturer un service éteint.
2. `docker compose -f server/compose.yml down` arrête tout et garde le volume (`down -v` efface la base : à ne faire qu'après sauvegarde).
3. Retire le bloc de `/opt/reverse-proxy/Caddyfile` et le réseau `friponnet` du compose de Caddy, puis recharge Caddy.
4. Dans Stripe, archive les trois prix et le produit, et désactive l'endpoint webhook.

## Développement en local

`npm --prefix server install`, puis `npm --prefix server run dev` : esbuild en watch et `node --watch`, sur `http://localhost:8787`. Sans `server/.env` le serveur démarre en développement : le code de connexion s'affiche dans la console à la place d'un mail (n'ajoute pas `SMTP_URL`), et les clés Google restent vides. Pour tester Stripe, mets une clé `sk_test_...` dans `server/.env` et relaie les événements avec `stripe listen --forward-to localhost:8787/v1/stripe/webhook` (il affiche le `whsec_...` à utiliser). Les tests : `npm --prefix server test`.
