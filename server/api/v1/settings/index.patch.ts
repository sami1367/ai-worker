import { readBody } from 'h3'
import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { assertSettingRanges, updateSettings } from '#services/settings'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const patch = assertSettingRanges(await readBody(event))
  return updateSettings(patch, { id: user.id, username: user.username }, clientIpHash(event))
}))
