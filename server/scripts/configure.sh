#!/usr/bin/env bash
# Fills the secrets of server/.env on the VPS, then sets up Stripe (products, prices, portal,
# webhook) and stores the webhook signing secret and the portal configuration by itself.
#   ssh -t vps /opt/fripon-cloud/server/scripts/configure.sh
# Secrets are typed hidden and never printed. Running it again keeps every value left empty.
# The AI review is written by Claude (Anthropic key) or Gemini (Google key): the run asks which,
# and then only the key of that provider.
#   configure.sh --smtp           SMTP settings on stdin (host, port, login, password)
#   configure.sh --google-keys    Vision key, then Gemini key, on stdin
#   configure.sh --anthropic-key  the Anthropic key on stdin; also sets AI_PROVIDER=claude
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

# Percent-encodes a URL part byte by byte (LC_ALL=C), so any password fits in SMTP_URL.
urlencode() {
  local LC_ALL=C s=$1 out='' c code hex i
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [a-zA-Z0-9.~_-]) out+=$c ;;
      *)
        # A byte above 127 reads as negative: keep its low 8 bits.
        printf -v code '%d' "'$c"
        printf -v hex '%%%02X' $((code & 255))
        out+=$hex
        ;;
    esac
  done
  printf '%s' "$out"
}

# SMTP_URL from its parts: nobody has to know the URL form or encode a password by hand.
ask_smtp() {
  local answer host port user pass scheme
  if ! is_placeholder "$(current SMTP_URL)"; then
    read -r -p "Envoi des e-mails déjà configuré. Le garder ? (O/n) " answer
    [[ -z $answer || $answer =~ ^[oOyY] ]] && return 0
  fi
  echo "Envoi des e-mails (les identifiants SMTP de ton fournisseur, par exemple Brevo > SMTP & API) :"
  read -r -p "  Serveur [smtp-relay.brevo.com] : " host
  host=${host:-smtp-relay.brevo.com}
  while true; do
    read -r -p "  Port [587] : " port
    port=${port:-587}
    [[ $port =~ ^[0-9]+$ ]] && break
    echo "  Un nombre, par exemple 587."
  done
  while true; do
    read -r -p "  Identifiant : " user
    [[ -n $user ]] && break
  done
  while true; do
    read -r -s -p "  Mot de passe ou clé SMTP : " pass
    echo
    [[ -n $pass ]] && break
  done
  scheme=smtp
  [[ $port == 465 ]] && scheme=smtps
  set_value SMTP_URL "$scheme://$(urlencode "$user"):$(urlencode "$pass")@$host:$port"
}

# ask_default KEY LABEL DEFAULT: Entrée takes the current value, else the default.
ask_default() {
  local key=$1 label=$2 default=$3 old value
  old=$(current "$key")
  if ! is_placeholder "$old"; then default=$old; fi
  read -r -p "$label [$default] : " value
  set_value "$key" "${value:-$default}"
}

# ask_provider: who writes the AI review. Entrée keeps the current one, claude when there is none.
ask_provider() {
  local default value
  default=$(current AI_PROVIDER)
  default=${default:-claude}
  while true; do
    read -r -p "Fournisseur de l'avis IA, claude ou gemini [$default] : " value
    value=$(tr '[:upper:]' '[:lower:]' <<<"${value:-$default}")
    [[ $value == claude || $value == gemini ]] && break
    echo "  claude ou gemini."
  done
  set_value AI_PROVIDER "$value"
  provider=$value
}

# `--smtp`: host, port, login and password arrive on stdin, one per line (for instance read from
# another app's .env on the same server); surrounding quotes are dropped. Nothing else is asked.
if [[ ${1:-} == --smtp ]]; then
  parts=()
  for _ in 1 2 3 4; do
    IFS= read -r line || true
    line=${line#[\"\']}
    line=${line%[\"\']}
    parts+=("$line")
  done
  if [[ -z ${parts[0]} || ! ${parts[1]} =~ ^[0-9]+$ || -z ${parts[2]} || -z ${parts[3]} ]]; then
    echo "Quatre lignes attendues sur l'entrée standard : serveur, port, identifiant, mot de passe." >&2
    exit 1
  fi
  scheme=smtp
  [[ ${parts[1]} == 465 ]] && scheme=smtps
  set_value SMTP_URL "$scheme://$(urlencode "${parts[2]}"):$(urlencode "${parts[3]}")@${parts[0]}:${parts[1]}"
  unset parts line
  echo "Envoi des e-mails enregistré dans $ENV_FILE."
  exit 0
fi

# `--anthropic-key`: the Anthropic key arrives on stdin, one line (piped from the owner's machine,
# so nobody copies it by hand). Giving a Claude key means using Claude: AI_PROVIDER is set too.
# Nothing else is asked.
anthropic_pattern='^sk-ant-[A-Za-z0-9_-]{20,}$'
if [[ ${1:-} == --anthropic-key ]]; then
  # Typed by hand rather than piped: hidden like every other secret.
  if [[ -t 0 ]]; then
    IFS= read -r -s -p "Clé Anthropic (sk-ant-…) : " anthropic || true
    echo
  else
    IFS= read -r anthropic || true
  fi
  if [[ ! $anthropic =~ $anthropic_pattern ]]; then
    echo "Une clé Anthropic (sk-ant-…) attendue sur l'entrée standard." >&2
    exit 1
  fi
  set_value ANTHROPIC_API_KEY "$anthropic"
  set_value AI_PROVIDER claude
  unset anthropic
  echo "Clé Anthropic enregistrée dans $ENV_FILE ; l'avis de l'IA passe par Claude (AI_PROVIDER=claude)."
  exit 0
fi

# `--google-keys`: the Google keys arrive on stdin (Vision, then Gemini, which only the Gemini
# provider needs: one line is enough with Claude), piped from gcloud on the owner's machine, so
# nobody copies them by hand. Nothing else is asked.
if [[ ${1:-} == --google-keys ]]; then
  IFS= read -r vision || true
  IFS= read -r gemini || true
  key_pattern='^AIza[0-9A-Za-z_-]{30,}$'
  if [[ ! $vision =~ $key_pattern || (-n $gemini && ! $gemini =~ $key_pattern) ]]; then
    echo "Clés Google attendues sur l'entrée standard : Vision, puis Gemini (facultative)." >&2
    exit 1
  fi
  set_value GOOGLE_VISION_KEY "$vision"
  if [[ -n $gemini ]]; then
    set_value GEMINI_KEY "$gemini"
    echo "Clés Google Vision et Gemini enregistrées dans $ENV_FILE."
  else
    echo "Clé Google Vision enregistrée dans $ENV_FILE."
  fi
  unset vision gemini
  exit 0
fi

echo "Fripon Cloud : configuration de $ENV_FILE"
echo "Les secrets ne s'affichent pas pendant la saisie."
echo
ask OWNER_EMAIL "Adresse qui reçoit les alertes" 0 '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
ask_smtp
public_host=$(current PUBLIC_URL)
public_host=${public_host#*://}
public_host=${public_host%%/*}
# fripon.example.com -> no-reply@example.com: the sender the SMTP provider already knows.
ask_default MAIL_FROM "Expéditeur des codes" "Fripon <no-reply@${public_host#*.}>"
ask GOOGLE_VISION_KEY "Clé Google Vision (AIza…)" 1 '^AIza[0-9A-Za-z_-]{30,}$'
ask_provider
if [[ $provider == claude ]]; then
  ask ANTHROPIC_API_KEY "Clé Anthropic (sk-ant-…)" 1 "$anthropic_pattern"
  ai_key=ANTHROPIC_API_KEY
else
  ask GEMINI_KEY "Clé Gemini (AIza…)" 1 '^AIza[0-9A-Za-z_-]{30,}$'
  ai_key=GEMINI_KEY
fi
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
echo "  AI_PROVIDER : $provider"
for key in OWNER_EMAIL SMTP_URL MAIL_FROM GOOGLE_VISION_KEY "$ai_key" STRIPE_SECRET_KEY \
  STRIPE_WEBHOOK_SECRET STRIPE_PORTAL_CONFIGURATION AUTH_SECRET PUBLIC_URL TRUST_PROXY; do
  if is_placeholder "$(current "$key")"; then echo "  $key : MANQUANT"; else echo "  $key : ok"; fi
done
echo
echo "Terminé. Tu peux dire à Claude que la configuration est faite."
