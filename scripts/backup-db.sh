#!/usr/bin/env bash
set -euo pipefail

# Backup confiable de la DB SQLite de ExcaliDash.
# Garantías:
#   - Snapshot consistente vía better-sqlite3 backup API (online backup, no copia cruda).
#   - No deja archivos basura: escribe a .tmp y promueve con mv solo si TODO valida.
#   - Falla ruidosamente (exit != 0) si Docker/DB no responden o el snapshot es inválido.
#   - Avisa (WARN) si el snapshot es válido pero no tiene contenido (posible DB recreada/vacía).
#   - La retención solo corre tras un backup exitoso.

CONTAINER_NAME="${CONTAINER_NAME:-excalidash-backend}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
DB_NAME="excalidash"
DB_PATH_IN_CONTAINER="/app/prisma/dev.db"
SNAPSHOT_IN_CONTAINER="/tmp/excalidash-backup-snapshot.db"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DAY_OF_WEEK=$(date +%u)

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { log "ERROR: $*"; exit 1; }

mkdir -p "$BACKUP_DIR"

# --- Preflight: si algo de esto falla, NO se toca ningún backup existente ---
command -v docker >/dev/null 2>&1 || fail "docker no está en PATH"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 no está en PATH (necesario para validar)"
docker info >/dev/null 2>&1        || fail "el daemon de Docker no responde (¿Docker Desktop apagado?)"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME" \
  || fail "el contenedor '$CONTAINER_NAME' no está corriendo; no se hace backup"
docker exec "$CONTAINER_NAME" test -f "$DB_PATH_IN_CONTAINER" \
  || fail "no existe $DB_PATH_IN_CONTAINER dentro de '$CONTAINER_NAME'"

BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.db.gz"
TMP_FILE="${BACKUP_FILE}.tmp"
TMP_DB="$(mktemp -t excalidash_snapshot.XXXXXX)"
cleanup() {
  rm -f "$TMP_FILE" "$TMP_DB"
  docker exec "$CONTAINER_NAME" rm -f "$SNAPSHOT_IN_CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT

# --- Snapshot online (consistente aunque haya escrituras concurrentes) ---
docker exec "$CONTAINER_NAME" node -e "
  const db = require('better-sqlite3')('$DB_PATH_IN_CONTAINER', { readonly: true });
  db.backup('$SNAPSHOT_IN_CONTAINER')
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
" || fail "el snapshot online de SQLite falló"

docker cp -q "$CONTAINER_NAME:$SNAPSHOT_IN_CONTAINER" "$TMP_DB" \
  || fail "no se pudo copiar el snapshot fuera del contenedor"

# --- Validación de integridad y contenido (sobre el snapshot, antes de promover) ---
INTEGRITY="$(sqlite3 "$TMP_DB" 'PRAGMA integrity_check;' 2>/dev/null)" \
  || fail "el snapshot no es una base SQLite legible"
[ "$INTEGRITY" = "ok" ] || fail "integrity_check falló: $INTEGRITY"

for table in User Drawing SystemConfig _prisma_migrations; do
  sqlite3 "$TMP_DB" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$table';" | grep -q 1 \
    || fail "el snapshot no contiene la tabla esperada '$table' (schema incompleto)"
done

USERS=$(sqlite3 "$TMP_DB" 'SELECT count(*) FROM "User";')
DRAWINGS=$(sqlite3 "$TMP_DB" 'SELECT count(*) FROM "Drawing";')
COLLECTIONS=$(sqlite3 "$TMP_DB" 'SELECT count(*) FROM "Collection";')

gzip -c "$TMP_DB" > "$TMP_FILE"
gzip -t "$TMP_FILE" 2>/dev/null || fail "el archivo gzip resultó corrupto"

# --- Promoción atómica (recién aquí el backup pasa a ser definitivo) ---
mv "$TMP_FILE" "$BACKUP_FILE"

SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
log "OK: $BACKUP_FILE ($SIZE) — User=$USERS Drawing=$DRAWINGS Collection=$COLLECTIONS"

if [ "$DRAWINGS" -eq 0 ] && [ "$USERS" -eq 0 ] && [ "$COLLECTIONS" -eq 0 ]; then
  log "WARN: la base no tiene contenido (0 drawings, 0 users, 0 collections). ¿DB recién creada o vacía?"
fi

# --- Snapshot semanal (domingos) ---
if [ "$DAY_OF_WEEK" -eq 7 ]; then
  cp "$BACKUP_FILE" "$BACKUP_DIR/${DB_NAME}_weekly_${TIMESTAMP}.db.gz"
  log "snapshot semanal creado"
fi

# --- Retención: SOLO tras un backup exitoso ---
find "$BACKUP_DIR" -name "${DB_NAME}_2*.db.gz" -mtime +7 -delete
find "$BACKUP_DIR" -name "${DB_NAME}_weekly_*.db.gz" -mtime +28 -delete
