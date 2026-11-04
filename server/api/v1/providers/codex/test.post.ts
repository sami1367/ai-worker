import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { testProvider } from '#services/providers'

// Keep this explicit beside Codex's login routes: the static codex subtree
// takes precedence over the generic [provider]/test route.
export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  return testProvider('codex')
}))
