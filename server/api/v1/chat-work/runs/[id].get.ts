import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { ownedChatWorkRun, publicChatWorkRun } from '#services/chat-work'
import { chatWorkLog } from '#services/chat-work-execution'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  const run = await ownedChatWorkRun(getRouterParam(event, 'id')!, user.id)
  return { run: publicChatWorkRun(run), log: await chatWorkLog(run.id) }
}))
