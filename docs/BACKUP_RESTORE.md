# Backup and restore

## What to back up

1. PostgreSQL database (users, repos, settings, task metadata, audit logs, sessions)
2. Persistent volumes: `configdata`, `workspaces`, `logsdata`, `statedata`
3. Offline copy of `.env` secrets (`SECRET_ENCRYPTION_KEY`, session secret, forge tokens)

Task history rows remain even if log files expire (`log_expired` flag).

## Backup

```bash
./scripts/backup.sh ./backups/manual-$(date -u +%Y%m%d)
```

Or manually:

```bash
docker compose exec -T db pg_dump -U aiworker aiworker > backup.sql
docker run --rm -v ai-worker_workspaces:/data -v "$PWD/backups:/backup" alpine \
  tar -czf /backup/workspaces.tar.gz -C /data .
```

## Restore

```bash
./scripts/restore.sh ./backups/<dir>
docker compose restart web worker
```

Restore workspace/log tarballs into the corresponding named volumes before starting the worker if you need historical logs/clones.

## Notes

- Never commit backup files containing production data.
- Restoring DB without the matching `SECRET_ENCRYPTION_KEY` leaves provider secrets undecryptable.
