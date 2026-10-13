import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { runQueueSync } from '#services/queue-scheduler'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  return runQueueSync('manual')
}))
