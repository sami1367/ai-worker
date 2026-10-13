#!/usr/bin/env bash
set -euo pipefail

# Backup PostgreSQL and the Compose data volume.
# Usage: ./scripts/backup.sh [output-dir]

OUT="${1:-./backups/$(date -u +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "Backing up to $OUT"

docker compose exec -T db pg_dump -U "${POSTGRES_USER:-aiworker}" "${POSTGRES_DB:-aiworker}" > "$OUT/db.sql"
echo "Wrote $OUT/db.sql"

PROJECT="$(basename "$(pwd)")"
docker run --rm \
  -v "${PROJECT}_data:/data:ro" \
  -v "${OUT}:/backup" \
  alpine tar -czf /backup/data.tar.gz -C /data . \
  || echo "NOTE: data volume archive skipped (compose volumes may differ by project name)"

echo "Backup complete: $OUT"
echo "Store SECRET_ENCRYPTION_KEY and session secrets separately — they are not in the DB dump alone for app decrypt."
