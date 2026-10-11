import { checkDatabaseConnectivity } from '#utils/db'
import { setupStatus } from '#services/auth'

export default defineEventHandler(async (event) => {
  const db = await checkDatabaseConnectivity()
  const setup = await setupStatus().catch(() => ({ needsSetup: true, hasUsers: false }))
  const ready = db.ok
  setResponseStatus(event, ready ? 200 : 503)
  return {
    ready,
    database: db,
    setup,
    time: new Date().toISOString(),
  }
})
