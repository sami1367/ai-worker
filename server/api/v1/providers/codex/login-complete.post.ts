import { handleApi, clientIpHash } from '#utils/api'
import { requireAdmin } from '#utils/session'
import { updateProvider } from '#services/providers'
import { codexChatgptConnected, acknowledgeCodexLogin, codexLoginState } from '#services/codex-auth'
import { AppError } from '#utils/errors'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireAdmin(event)
  codexLoginState(user.id)
  if (!codexChatgptConnected()) throw new AppError(400, 'Complete ChatGPT login first', 'validation_error')
  const key = useRuntimeConfig().secretEncryptionKey || process.env.SECRET_ENCRYPTION_KEY || ''
  const provider = await updateProvider('codex', {
    isEnabled: true, config: { credentialType: 'chatgpt' },
  }, user, key, clientIpHash(event))
  acknowledgeCodexLogin(user.id)
  return provider
}))
