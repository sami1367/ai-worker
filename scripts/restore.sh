#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/restore.sh <backup-dir>
DIR="${1:-}"
if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  echo "Usage: $0 <backup-dir>"
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ ! -f "$DIR/db.sql" ]]; then
  echo "ERROR: $DIR/db.sql not found"
  exit 1
fi

echo "Restoring database from $DIR/db.sql"
docker compose exec -T db psql -U "${POSTGRES_USER:-aiworker}" -d "${POSTGRES_DB:-aiworker}" < "$DIR/db.sql"
echo "Database restore complete. Restart web/worker if needed: docker compose restart web worker"
