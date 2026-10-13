import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getPlatformSshPublicKeyInfo } from '#services/platform-ssh'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const info = await getPlatformSshPublicKeyInfo()
  // Explicit allow-list — never return private key material.
  return {
    publicKey: info.publicKey,
    fingerprint: info.fingerprint,
    keyType: info.keyType,
    comment: info.comment,
    privateKeyPresent: info.privateKeyPresent,
  }
}))
