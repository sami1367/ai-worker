import { readBody } from 'h3'
import { z } from 'zod'
import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { updateProvider } from '#services/providers'

const schema = z.object({
  isEnabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  secret: z.string().nullable().optional(),
})

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const provider = getRouterParam(event, 'provider')!
  const body = schema.parse(await readBody(event))
  const key = useRuntimeConfig().secretEncryptionKey || process.env.SECRET_ENCRYPTION_KEY || ''
  return updateProvider(provider, body, { id: user.id, username: user.username }, key, clientIpHash(event))
}))
