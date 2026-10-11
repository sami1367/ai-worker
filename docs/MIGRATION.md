# Configuration migration

## From legacy host install

Existing files (legacy host install or `worker/` data dir):

- `github-projects.conf` / `gitlab-projects.conf` (runtime; templates in `worker/*.conf.example`)
- `.env` (GITLAB_*, AI_PROVIDER, etc.)

### Dry-run

```bash
export DATABASE_URL=postgresql://...
pnpm migrate:config -- --base /path/to/old/or/worker --dry-run
# default is dry-run unless --apply
pnpm exec tsx scripts/migrate-config.ts --base ./worker
```

### Apply

```bash
pnpm exec tsx scripts/migrate-config.ts --base /home/ubuntu/ai-worker --apply
```

Behavior:

- Validates JSON arrays (comment headers allowed)
- Imports name/path/`block_on_open_pr`
- Leaves repositories **disabled** until you set a real remote URL and test
- Skips duplicates (same name + forge)
- Never rewrites or deletes original conf files
- Does not print secrets

After import, use the UI to set remotes, run connection tests, setup labels, and enable repositories. Then **Reload config** so the worker export regenerates conf files under the platform data volume.

## Linking legacy repositories to OAuth connections

After connecting GitHub/GitLab:

1. Refresh discovery on the connection.
2. When registering a discovered repo, the platform matches by provider identity (`forge` + instance + provider repo id) first.
3. If a legacy row shares the same remote URL but a conflicting short name, it is linked instead of duplicated.
4. Ambiguous name conflicts without a matching remote are skipped (`name_conflict`) for explicit resolution — nothing is deleted.
5. Existing workspaces/host paths are preserved; use **Clone / repair** or **Sync** only when you want managed workspace operations.

## Path compatibility

Worker entry points live only under `worker/` (no root-level script wrappers). The systemd unit and Docker entrypoint already use `worker/worker.sh` (or `/data/config/worker.sh` after volume sync). Set `AI_WORKER_BASE_DIR` when runtime conf/logs/state are not beside the scripts.

## Rollback

1. Stop platform worker container / keep host worker stopped to avoid dual writers.
2. Restore previous conf files (untouched by import).
3. Point systemd `ExecStart` back to the previous layout if needed.
4. Restore PostgreSQL from backup if schema/data must be reverted.
