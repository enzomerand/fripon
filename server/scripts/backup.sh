#!/usr/bin/env bash
# Backs up the Fripon Cloud database on the VPS, from a daily cron (see docs/cloud.md, "Sauvegarde").
#   server/scripts/backup.sh                  makes today's backup, proves it can be read, rotates
#   server/scripts/backup.sh --verify <file>  checks that a backup can be restored, changes nothing
#   server/scripts/backup.sh --restore <file> replaces the database by a backup, after a confirmation
#
# A backup that fails deletes nothing, leaves today's earlier backup in place, exits non-zero and
# e-mails the owner. Files go through stdin: a backup is readable by root only, and the container
# runs as `node`. FRIPON_BACKUP_DIR overrides the destination (the tests use it).
set -euo pipefail
umask 077

SERVER_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE=(docker compose -f "$SERVER_DIR/compose.yml")
SERVICE=fripon-cloud
BACKUP_DIR=${FRIPON_BACKUP_DIR:-/var/backups/fripon-cloud}
IN_CONTAINER=/data/backup.db

# Reads a backup in a throwaway container, the way a restored server would.
verify_file() {
  "${COMPOSE[@]}" run --rm --no-deps -T "$SERVICE" sh -c \
    'cat > /tmp/check.db && node dist/backup.js verify /tmp/check.db' < "$1"
}

need_file() {
  if [[ ! -f "$1" ]]; then
    echo "Fichier introuvable : $1" >&2
    exit 1
  fi
}

backup() {
  # Not local: the trap runs after this function has returned.
  today=$(date +%F)
  target="$BACKUP_DIR/fripon-$today.db"
  part="$BACKUP_DIR/.fripon-$today.part"

  # shellcheck disable=SC2329 # called by the trap
  finish() {
    local status=$?
    rm -f "$part"
    "${COMPOSE[@]}" exec -T "$SERVICE" rm -f "$IN_CONTAINER" "$IN_CONTAINER-wal" "$IN_CONTAINER-shm" \
      > /dev/null 2>&1 || true
    if ((status != 0)); then
      echo "Échec de la sauvegarde du $today." >&2
      "${COMPOSE[@]}" run --rm --no-deps -T "$SERVICE" node dist/backup.js alert \
        "The backup of $today failed (exit code $status): the database is not being saved. See /var/log/fripon-cloud-backup.log on the server." \
        || echo "L'alerte n'a pas pu être envoyée." >&2
    fi
  }
  trap finish EXIT

  mkdir -p -m 700 "$BACKUP_DIR"
  "${COMPOSE[@]}" exec -T "$SERVICE" node dist/backup.js create "$IN_CONTAINER"
  "${COMPOSE[@]}" cp "$SERVICE:$IN_CONTAINER" "$part"
  chmod 600 "$part"
  verify_file "$part"
  mv "$part" "$target"

  # The rotation only runs after a good backup. The privacy policy says 30 days at most
  # (BACKUP_KEEP_DAYS, a test compares): -mtime counts whole days and the cron's time drifts by a
  # few seconds, so +28 is what removes a file by its 30th day. A .part is left by a power cut.
  find "$BACKUP_DIR" \( -name 'fripon-*.db' -o -name '.fripon-*.part' \) -mtime +28 -delete
  echo "Sauvegarde vérifiée : $target"
}

restore() {
  need_file "$1"
  verify_file "$1"

  echo "La base actuelle sera remplacée par $1. Ce qui s'est passé depuis cette sauvegarde sera perdu."
  printf 'Tape RESTAURER pour confirmer : '
  local answer=''
  read -r answer || true
  if [[ "$answer" != "RESTAURER" ]]; then
    echo "Annulé : rien n'a changé."
    exit 1
  fi

  # Whatever happens from here (a failure, Ctrl-C, a lost SSH session), the server comes back.
  trap '"${COMPOSE[@]}" up -d "$SERVICE"' EXIT
  "${COMPOSE[@]}" stop "$SERVICE"
  # The -wal goes with the old database: after a crash it holds its last writes. mkdir refuses a
  # copy already there: restoring twice must not replace the original state by the first restore.
  # The new file only takes its place once it is complete. A -wal left behind would be replayed on it.
  if ! "${COMPOSE[@]}" run --rm --no-deps -T "$SERVICE" sh -c '
    set -e
    cat > /data/fripon.db.new
    mkdir /data/before-restore
    cp /data/fripon.db /data/before-restore/
    if [ -e /data/fripon.db-wal ]; then cp /data/fripon.db-wal /data/before-restore/; fi
    rm -f /data/fripon.db-wal /data/fripon.db-shm
    mv /data/fripon.db.new /data/fripon.db
  ' < "$1"; then
    echo "Échec de la restauration : le serveur repart sur la base actuelle. Si /data/before-restore existe déjà, c'est la copie d'une restauration précédente : supprime-la d'abord." >&2
    exit 1
  fi
  trap - EXIT
  "${COMPOSE[@]}" up -d --wait "$SERVICE"

  echo "Base restaurée, serveur relancé. L'ancienne base est dans le volume : /data/before-restore."
  echo "Reprends l'état de Stripe : docker compose -f server/compose.yml exec -T $SERVICE node dist/stripe-resync.js"
  echo "Puis supprime l'ancienne base : docker compose -f server/compose.yml exec -T $SERVICE rm -r /data/before-restore"
}

case "${1:-}" in
  '')
    backup
    ;;
  --verify)
    need_file "${2:-}"
    verify_file "$2"
    ;;
  --restore)
    restore "${2:-}"
    ;;
  *)
    echo "Usage : backup.sh [--verify <fichier> | --restore <fichier>]" >&2
    exit 2
    ;;
esac
