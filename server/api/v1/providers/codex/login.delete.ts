import { handleApi, clientIpHash } from '#utils/api'
import { requireAdmin } from '#utils/session'
import { updateProvider, listProviders } from '#services/providers'
import { disconnectCodexLogin } from '#services/codex-auth'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireAdmin(event)
  await disconnectCodexLogin(user.id)
  const key = useRuntimeConfig().secretEncryptionKey || process.env.SECRET_ENCRYPTION_KEY || ''
  const providers = await listProviders()
  const accountMode = providers.find((p) => p.providerType === 'codex')?.config?.credentialType === 'chatgpt'
  return updateProvider('codex', accountMode ? { isEnabled: false } : {}, user, key, clientIpHash(event))
}))
