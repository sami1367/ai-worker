import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getWorkerStatus, listRecentWorkerEvents } from '#services/worker'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const status = await getWorkerStatus()
  const events = await listRecentWorkerEvents(20)
  return { ...status, recentEvents: events }
}))
