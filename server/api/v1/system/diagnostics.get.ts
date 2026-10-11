import { handleApi, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { checkDatabaseConnectivity } from '#utils/db'
import { getWorkerStatus } from '#services/worker'
import { listProviders, testProvider } from '#services/providers'
import { getSettings } from '#services/settings'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function cmdOk(cmd: string) {
  try {
    await execFileAsync('bash', ['-lc', `command -v ${cmd}`], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const [database, worker, providers, settings, git, gh, jq, flock] = await Promise.all([
    checkDatabaseConnectivity(),
    getWorkerStatus(),
    listProviders(),
    getSettings(),
    cmdOk('git'),
    cmdOk('gh'),
    cmdOk('jq'),
    cmdOk('flock'),
  ])
  return {
    application: {
      version: useRuntimeConfig().appVersion || '1.0.0',
      nodeEnv: process.env.NODE_ENV || 'development',
      time: new Date().toISOString(),
    },
    database,
    worker,
    providers,
    settings: {
      configVersion: settings.configVersion,
      pollIntervalSeconds: settings.pollIntervalSeconds,
      defaultAiProvider: settings.defaultAiProvider,
    },
    tools: { git, gh, jq, flock },
  }
}))
