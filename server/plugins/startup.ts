import { checkDatabaseConnectivity } from '#utils/db'
import { startWorkspaceOperationWorker } from '#services/workspace-manager'
import { startDiscoveryScheduler } from '#services/discovery-scheduler'
import { startQueueScheduler } from '#services/queue-scheduler'
import { exportForgeCredentialsForWorker } from '#services/forge-credentials'
import { exportProviderCredentialsForWorker } from '#services/provider-credentials'
import { exportWorkerConfig } from '#services/config-sync'
import { exportWorkerRuntimeEnv } from '#services/worker-runtime'
import { exportCodegraphEnv } from '#services/codegraph'
import { ensureProviderRows } from '#services/providers'
import { ensurePromptRows } from '#services/prompts'
import {
  ensureAppSecrets,
  shouldFailOnSecretIssues,
} from '#utils/app-secrets'
import { ensurePlatformSshKey } from '#services/platform-ssh'

export default defineNitroPlugin(async () => {
  const secrets = await ensureAppSecrets(process.env)
  if (!secrets.ok) {
    const line = `[startup] ${secrets.message}`
    if (shouldFailOnSecretIssues(process.env)) {
      console.error(line)
      throw new Error(secrets.message)
    }
    console.warn(`${line} (continuing in non-strict mode)`)
  } else if (secrets.filledFromDisk.length) {
    console.log(`[startup] Loaded ${secrets.filledFromDisk.length} secret(s) from persisted app-secrets.env`)
  } else if (secrets.persisted) {
    console.log('[startup] Application secrets ready (persisted on data volume)')
  }

  try {
    const db = await checkDatabaseConnectivity()
    if (!db.ok) {
      console.warn(`[startup] Database not ready: ${db.message}`)
    } else {
      try {
        await ensureProviderRows()
        const prompts = await ensurePromptRows()
        console.log(`[startup] Prompt seed: ${prompts.inserted} inserted, ${prompts.total} total`)
        await exportForgeCredentialsForWorker()
        await exportProviderCredentialsForWorker()
        await exportWorkerRuntimeEnv()
        await exportCodegraphEnv()
        // Ensure project conf includes full_name for work-first discovery / lazy clone
        await exportWorkerConfig()
      } catch (err) {
        console.warn(
          '[startup] Credential materialization skipped:',
          err instanceof Error ? err.message : err,
        )
      }
    }
  } catch (err) {
    console.warn('[startup] Database check skipped:', err instanceof Error ? err.message : err)
  }

  try {
    const ssh = await ensurePlatformSshKey()
    console.log(
      ssh.created
        ? '[startup] Generated platform SSH key (add the public key in Connections)'
        : '[startup] Platform SSH key ready',
    )
  } catch (err) {
    console.warn('[startup] Platform SSH key not ready:', err instanceof Error ? err.message : err)
  }

  try {
    startWorkspaceOperationWorker()
  } catch (err) {
    console.warn('[startup] Workspace worker not started:', err instanceof Error ? err.message : err)
  }

  try {
    startDiscoveryScheduler()
  } catch (err) {
    console.warn('[startup] Discovery scheduler not started:', err instanceof Error ? err.message : err)
  }

  try {
    startQueueScheduler()
  } catch (err) {
    console.warn('[startup] Task queue scheduler not started:', err instanceof Error ? err.message : err)
  }
})
