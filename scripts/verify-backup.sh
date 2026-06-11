#!/usr/bin/env bash
set -euo pipefail

# Verify the latest SQLite backup is restorable and coherent.
# Exit 0 = backup verified, non-zero = problem.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"

EXPECTED_TABLES=(
  "User" "SystemConfig" "Collection" "Drawing" "DrawingSnapshot"
  "DrawingPermission" "DrawingLinkShare" "Library" "PasswordResetToken"
  "RefreshToken" "AuditLog" "AuthIdentity" "_prisma_migrations"
)

command -v sqlite3 >/dev/null 2>&1 || { echo "FAIL: sqlite3 no está en PATH"; exit 1; }

TMP_DB="$(mktemp -t excalidash_verify.XXXXXX)"
cleanup() { rm -f "$TMP_DB"; }
trap cleanup EXIT

# Find latest backup
LATEST_BACKUP=$(ls -t "$BACKUP_DIR"/*.db.gz 2>/dev/null | head -1)
if [ -z "$LATEST_BACKUP" ]; then
  echo "FAIL: No .db.gz backups found in $BACKUP_DIR"
  exit 1
fi

echo "=== Backup Restore Verification ==="
echo "Backup: $(basename "$LATEST_BACKUP")"
echo "Size:   $(du -h "$LATEST_BACKUP" | cut -f1)"
echo "Date:   $(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$LATEST_BACKUP" 2>/dev/null || stat -c '%y' "$LATEST_BACKUP" 2>/dev/null | cut -d. -f1)"
echo ""

# Restore (gunzip) and check integrity
gunzip -c "$LATEST_BACKUP" > "$TMP_DB" || { echo "FAIL: gunzip falló"; exit 1; }

INTEGRITY=$(sqlite3 "$TMP_DB" 'PRAGMA integrity_check;')
if [ "$INTEGRITY" != "ok" ]; then
  echo "FAIL: integrity_check: $INTEGRITY"
  exit 1
fi
echo "OK: integrity_check"

# Verify all expected tables exist and count rows
MISSING=0
for table in "${EXPECTED_TABLES[@]}"; do
  EXISTS=$(sqlite3 "$TMP_DB" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$table';")
  if [ "$EXISTS" != "1" ]; then
    echo "FAIL: tabla faltante: $table"
    MISSING=1
    continue
  fi
  ROW_COUNT=$(sqlite3 "$TMP_DB" "SELECT count(*) FROM \"$table\";")
  printf "OK: %-22s %s filas\n" "$table" "$ROW_COUNT"
done
[ "$MISSING" -eq 0 ] || exit 1

# Coherence: applied migrations present
MIGRATION_COUNT=$(sqlite3 "$TMP_DB" 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;')
if [ "$MIGRATION_COUNT" -lt 1 ]; then
  echo "FAIL: _prisma_migrations sin migraciones aplicadas"
  exit 1
fi
echo "OK: $MIGRATION_COUNT migraciones aplicadas"

echo ""
echo "=== Backup verificado ==="
