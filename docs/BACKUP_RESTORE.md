# Backup and restore

## What to back up

1. PostgreSQL database (users, repos, settings, task metadata, audit logs, sessions)
2. Persistent volumes: `pgdata` (Postgres) and `data` (`/data` — config, workspaces, logs, state)
3. Offline copy of secrets (`SECRET_ENCRYPTION_KEY`, session secret, Postgres password, worker token) — from host `.env` and/or `/data/config/app-secrets.env` on the data volume

Task history rows remain even if log files expire (`log_expired` flag).

## Backup

```bash
./scripts/backup.sh ./backups/manual-$(date -u +%Y%m%d)
```

Or manually:

```bash
docker compose exec -T db pg_dump -U aiworker aiworker > backup.sql
docker run --rm -v ai-worker_data:/data:ro -v "$PWD/backups:/backup" alpine \
  tar -czf /backup/data.tar.gz -C /data .
```

## Restore

```bash
./scripts/restore.sh ./backups/<dir>
docker compose restart web worker
```

Restore `data.tar.gz` into the `data` named volume before starting the worker if you need historical logs/clones.

## Notes

- Never commit backup files containing production data.
- Restoring DB without the matching `SECRET_ENCRYPTION_KEY` leaves provider secrets undecryptable.
