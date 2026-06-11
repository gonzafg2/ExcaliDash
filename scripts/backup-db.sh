#!/usr/bin/env bash
set -euo pipefail

# Backup confiable de la DB de ExcaliDash.
# Garantías:
#   - No deja archivos basura: escribe a .tmp y promueve con mv solo si TODO valida.
#   - Falla ruidosamente (exit != 0) si Docker/DB no responden o el dump es inválido.
#   - Avisa (WARN) si el dump es válido pero no tiene contenido (posible DB recreada/vacía).
#   - La retención solo corre tras un backup exitoso.

CONTAINER_NAME="${CONTAINER_NAME:-excalidash-db}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
ENV_FILE="$PROJECT_DIR/.env"

# Fuente de verdad: .env del proyecto (con fallback a defaults).
DB_USER="${POSTGRES_USER:-excalidash}"
DB_NAME="${POSTGRES_DB:-excalidash}"
if [ -f "$ENV_FILE" ]; then
  _u="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  _d="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  DB_USER="${_u:-$DB_USER}"
  DB_NAME="${_d:-$DB_NAME}"
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DAY_OF_WEEK=$(date +%u)

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { log "ERROR: $*"; exit 1; }

mkdir -p "$BACKUP_DIR"

# --- Preflight: si algo de esto falla, NO se toca ningún backup existente ---
command -v docker >/dev/null 2>&1 || fail "docker no está en PATH"
docker info >/dev/null 2>&1        || fail "el daemon de Docker no responde (¿Docker Desktop apagado?)"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME" \
  || fail "el contenedor '$CONTAINER_NAME' no está corriendo; no se hace backup"
docker exec "$CONTAINER_NAME" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 \
  || fail "PostgreSQL no acepta conexiones en '$CONTAINER_NAME'"

BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz"
TMP_FILE="${BACKUP_FILE}.tmp"
ERR_FILE="$(mktemp -t excalidash_pgdump.XXXXXX)"
cleanup() { rm -f "$TMP_FILE" "$ERR_FILE"; }
trap cleanup EXIT

# --- Dump ---
# pipefail propaga el fallo de pg_dump aunque siga el gzip; el destino es .tmp,
# así que un fallo nunca corrompe el backup final.
if ! docker exec "$CONTAINER_NAME" pg_dump -U "$DB_USER" "$DB_NAME" 2>"$ERR_FILE" | gzip > "$TMP_FILE"; then
  log "stderr de pg_dump:"
  sed 's/^/    /' "$ERR_FILE" >&2 || true
  fail "pg_dump falló"
fi

# --- Validación de integridad (un solo pase de descompresión) ---
gzip -t "$TMP_FILE" 2>/dev/null || fail "el archivo gzip resultó corrupto"

# Verifica cabecera, presencia de tablas clave del schema y cuenta filas de contenido.
read -r HDR T_USER T_DRAWING T_SC T_MIG DRAWINGS USERS COLLECTIONS < <(
  gunzip -c "$TMP_FILE" | awk '
    /PostgreSQL database dump/                       { hdr=1 }
    /^CREATE TABLE public\."?User"? /                { t_user=1 }
    /^CREATE TABLE public\."?Drawing"? /             { t_drawing=1 }
    /^CREATE TABLE public\."?SystemConfig"? /        { t_sc=1 }
    /^CREATE TABLE public\."?_prisma_migrations"? /  { t_mig=1 }
    /^COPY public\."Drawing" /                       { cd=1; next }
    /^COPY public\."User" /                          { cu=1; next }
    /^COPY public\."Collection" /                    { cc=1; next }
    cd && /^\\\.$/ { cd=0 }
    cu && /^\\\.$/ { cu=0 }
    cc && /^\\\.$/ { cc=0 }
    cd { dr++ } cu { us++ } cc { co++ }
    END { print hdr+0, t_user+0, t_drawing+0, t_sc+0, t_mig+0, dr+0, us+0, co+0 }
  '
)

[ "$HDR" = "1" ]      || fail "el dump no tiene la cabecera de pg_dump (output inválido)"
[ "$T_USER" = "1" ] && [ "$T_DRAWING" = "1" ] && [ "$T_SC" = "1" ] && [ "$T_MIG" = "1" ] \
  || fail "el dump no contiene todas las tablas esperadas (schema incompleto: User=$T_USER Drawing=$T_DRAWING SystemConfig=$T_SC _prisma_migrations=$T_MIG)"

# --- Promoción atómica (recién aquí el backup pasa a ser definitivo) ---
mv "$TMP_FILE" "$BACKUP_FILE"
trap 'rm -f "$ERR_FILE"' EXIT

SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
log "OK: $BACKUP_FILE ($SIZE) — User=$USERS Drawing=$DRAWINGS Collection=$COLLECTIONS"

if [ "$DRAWINGS" -eq 0 ] && [ "$USERS" -eq 0 ] && [ "$COLLECTIONS" -eq 0 ]; then
  log "WARN: la base no tiene contenido (0 drawings, 0 users, 0 collections). ¿DB recién creada o vacía?"
fi

# --- Snapshot semanal (domingos) ---
if [ "$DAY_OF_WEEK" -eq 7 ]; then
  cp "$BACKUP_FILE" "$BACKUP_DIR/${DB_NAME}_weekly_${TIMESTAMP}.sql.gz"
  log "snapshot semanal creado"
fi

# --- Retención: SOLO tras un backup exitoso ---
find "$BACKUP_DIR" -name "${DB_NAME}_2*.sql.gz" -mtime +7 -delete
find "$BACKUP_DIR" -name "${DB_NAME}_weekly_*.sql.gz" -mtime +28 -delete
