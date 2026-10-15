import { listConnections } from './connections'
import { listProviders } from './providers'
import { repositoryCounts } from './repositories'

export type SetupIssue =
  | 'none'
  | 'unhealthy'
  | 'none_enabled'
  | null

export async function getSetupReadiness() {
  const [connections, providers, repos] = await Promise.all([
    listConnections(),
    listProviders(),
    repositoryCounts(),
  ])

  const connectionItems = connections.items
  const activeConnections = connectionItems.filter((c) => c.status === 'active')
  const hasHealthyConnection = activeConnections.length > 0
  const connectionIssue: SetupIssue = connectionItems.length === 0
    ? 'none'
    : hasHealthyConnection
      ? null
      : 'unhealthy'

  const knownProviders = providers.filter((p) => p.providerType === 'cursor' || p.providerType === 'claude')
  const activeProviders = knownProviders.filter((p) => p.isEnabled && p.hasSecret)
  const hasActiveProvider = activeProviders.length > 0
  const providerIssue: SetupIssue = hasActiveProvider ? null : 'none'

  const hasEnabledRepo = repos.enabled > 0
  const repositoryIssue: SetupIssue = repos.total === 0
    ? 'none'
    : hasEnabledRepo
      ? null
      : 'none_enabled'

  return {
    connections: {
      ok: hasHealthyConnection,
      total: connectionItems.length,
      active: activeConnections.length,
      issue: connectionIssue,
    },
    providers: {
      ok: hasActiveProvider,
      total: knownProviders.length,
      active: activeProviders.length,
      issue: providerIssue,
    },
    repositories: {
      ok: hasEnabledRepo,
      total: repos.total,
      enabled: repos.enabled,
      issue: repositoryIssue,
    },
    navWarnings: {
      connections: !hasHealthyConnection,
      providers: !hasActiveProvider,
      repositories: !hasEnabledRepo,
    },
  }
}
