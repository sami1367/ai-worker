import { readBody } from 'h3'
import { z } from 'zod'
import { handleApi, clientIpHash } from '#utils/api'
import { changePassword } from '#services/auth'
import { clearSessionCookie, requireUser } from '#utils/session'

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(200),
})

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  const body = schema.parse(await readBody(event))
  await changePassword({
    userId: user.id,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
    ipHash: clientIpHash(event),
  })
  clearSessionCookie(event)
  return { ok: true, reauthRequired: true }
}))
