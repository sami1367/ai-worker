import { checkDatabaseConnectivity } from '#utils/db'
import { startWorkspaceOperationWorker } from '#services/workspace-manager'

export default defineNitroPlugin(async () => {
  const required = ['DATABASE_URL', 'NUXT_SESSION_PASSWORD']
  // SESSION_SECRET accepted as alias during boot validation message
  const missing: string[] = []
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL')
  if (!process.env.NUXT_SESSION_PASSWORD && !process.env.SESSION_SECRET) {
    missing.push('NUXT_SESSION_PASSWORD (or SESSION_SECRET)')
  }
  if (!process.env.SECRET_ENCRYPTION_KEY) missing.push('SECRET_ENCRYPTION_KEY')

  if (missing.length && process.env.NODE_ENV === 'production') {
    console.error(`[startup] Missing required configuration: ${missing.join(', ')}`)
  } else if (missing.length) {
    console.warn(`[startup] Configuration incomplete (dev): ${missing.join(', ')}`)
  }

  // Alias SESSION_SECRET -> NUXT_SESSION_PASSWORD for nuxt-auth-utils if needed
  if (!process.env.NUXT_SESSION_PASSWORD && process.env.SESSION_SECRET) {
    process.env.NUXT_SESSION_PASSWORD = process.env.SESSION_SECRET
  }

  try {
    const db = await checkDatabaseConnectivity()
    if (!db.ok) {
      console.warn(`[startup] Database not ready: ${db.message}`)
    }
  } catch (err) {
    console.warn('[startup] Database check skipped:', err instanceof Error ? err.message : err)
  }

  try {
    startWorkspaceOperationWorker()
  } catch (err) {
    console.warn('[startup] Workspace worker not started:', err instanceof Error ? err.message : err)
  }

  void required
})
