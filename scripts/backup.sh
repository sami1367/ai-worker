#!/usr/bin/env bash
set -euo pipefail

# Backup PostgreSQL and persistent worker volumes (Compose).
# Usage: ./scripts/backup.sh [output-dir]

OUT="${1:-./backups/$(date -u +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"

if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "Backing up to $OUT"

if [[ -n "${DATABASE_URL:-}" ]]; then
  docker compose exec -T db pg_dump -U "${POSTGRES_USER:-aiworker}" "${POSTGRES_DB:-aiworker}" > "$OUT/db.sql"
  echo "Wrote $OUT/db.sql"
else
  echo "WARNING: DATABASE_URL not set; skipped SQL dump"
fi

# Volume snapshots via tar from a helper container if compose is up
docker compose run --rm --no-deps -v "${OUT}:/backup" -v "$(basename "$(pwd)")_logsdata:/logs:ro" web \
  bash -lc 'tar -czf /backup/logs.tar.gz -C /data logs 2>/dev/null || tar -czf /backup/logs.tar.gz -C /logs . 2>/dev/null || true' \
  || echo "NOTE: log volume archive skipped (compose volumes may differ by project name)"

echo "Backup complete: $OUT"
echo "Store SECRET_ENCRYPTION_KEY and session secrets separately — they are not in the DB dump alone for app decrypt."
