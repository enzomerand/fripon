#!/usr/bin/env bash
# Fills the secrets of server/.env on the VPS, then sets up Stripe (products, prices, portal,
# webhook) and stores the webhook signing secret and the portal configuration by itself.
#   ssh -t vps /opt/fripon-cloud/server/scripts/configure.sh
# Secrets are typed hidden and never printed. Running it again keeps every value left empty.
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$SERVER_DIR/.env"
COMPOSE=(docker compose -f "$SERVER_DIR/compose.yml")

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Fichier introuvable : $ENV_FILE (copie d'abord .env.example en .env)." >&2
  exit 1
fi
umask 077

current() { grep -E "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2- || true; }

# awk reads the value from the environment: a password may hold any character, \ included.
set_value() {
  local tmp
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# The values of .env.example are placeholders, not settings.
is_placeholder() {
  case "$1" in
    "" | *... | *example.com* | "smtp://user:pass@host:587") return 0 ;;
    *) return 1 ;;
  esac
}

# ask KEY LABEL HIDDEN PATTERN
ask() {
  local key=$1 label=$2 hidden=$3 pattern=$4 old value prompt
  old=$(current "$key")
  if is_placeholder "$old"; then prompt="$label : "; else prompt="$label (Entrée = garder l'actuelle) : "; fi
  while true; do
    if [[ $hidden == 1 ]]; then
      read -r -s -p "$prompt" value
      echo
    else
      read -r -p "$prompt" value
    fi
    if [[ -z $value ]]; then
      if is_placeholder "$old"; then
        echo "  Valeur obligatoire."
        continue
      fi
      return 0
    fi
    if [[ ! $value =~ $pattern ]]; then
      echo "  Format inattendu, recommence."
      continue
    fi
    set_value "$key" "$value"
    return 0
  done
}

echo "Fripon Cloud : configuration de $ENV_FILE"
echo "Les secrets ne s'affichent pas pendant la saisie."
echo
ask OWNER_EMAIL "Adresse qui reçoit les alertes" 0 '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
ask SMTP_URL "SMTP (smtp://utilisateur:motdepasse@serveur:587, caractères spéciaux encodés)" 1 '^smtps?://[^@]+@[^@]+$'
ask MAIL_FROM "Expéditeur des codes (ex. Fripon <fripon@ton-domaine.fr>)" 0 '@'
ask GOOGLE_VISION_KEY "Clé Google Vision (AIza…)" 1 '^AIza[0-9A-Za-z_-]{30,}$'
ask GEMINI_KEY "Clé Gemini (AIza…)" 1 '^AIza[0-9A-Za-z_-]{30,}$'
ask STRIPE_SECRET_KEY "Clé secrète Stripe de TEST (sk_test_… ou rk_test_…)" 1 '^(sk|rk)_test_[0-9A-Za-z]+$'

echo
echo "Construction de l'image (rapide si rien n'a changé)…"
"${COMPOSE[@]}" build --quiet

public_url=$(current PUBLIC_URL)
echo "Configuration de Stripe (produits, prix, portail, webhook ${public_url}/v1/stripe/webhook)…"
if ! out=$("${COMPOSE[@]}" run --rm --no-deps fripon-cloud node dist/stripe-setup.js \
  --webhook "${public_url}/v1/stripe/webhook" 2>&1); then
  sed -E 's/whsec_[A-Za-z0-9]+/whsec_(masqué)/g' <<<"$out" >&2
  echo "La configuration de Stripe a échoué (voir ci-dessus). Rien d'autre n'a changé." >&2
  exit 1
fi
sed -E 's/whsec_[A-Za-z0-9]+/whsec_(masqué)/g' <<<"$out"

webhook_secret=$(grep -oE 'whsec_[A-Za-z0-9]+' <<<"$out" | head -n 1 || true)
portal=$(grep -oE 'bpc_[A-Za-z0-9]+' <<<"$out" | head -n 1 || true)
unset out
# The portal configuration the setup made: the server opens it even if it is not the default one.
[[ -n $portal ]] && set_value STRIPE_PORTAL_CONFIGURATION "$portal"
if [[ -n $webhook_secret ]]; then
  set_value STRIPE_WEBHOOK_SECRET "$webhook_secret"
  echo "Secret du webhook enregistré."
elif is_placeholder "$(current STRIPE_WEBHOOK_SECRET)"; then
  echo "Le webhook existait déjà : Stripe ne montre son secret qu'à la création."
  echo "Dashboard Stripe > Développeurs > Webhooks > l'endpoint > « Révéler » le secret de signature."
  ask STRIPE_WEBHOOK_SECRET "Secret du webhook (whsec_…)" 1 '^whsec_[A-Za-z0-9]+$'
fi
unset webhook_secret

echo
echo "État de $ENV_FILE :"
for key in OWNER_EMAIL SMTP_URL MAIL_FROM GOOGLE_VISION_KEY GEMINI_KEY STRIPE_SECRET_KEY \
  STRIPE_WEBHOOK_SECRET STRIPE_PORTAL_CONFIGURATION AUTH_SECRET PUBLIC_URL TRUST_PROXY; do
  if is_placeholder "$(current "$key")"; then echo "  $key : MANQUANT"; else echo "  $key : ok"; fi
done
echo
echo "Terminé. Tu peux dire à Claude que la configuration est faite."
