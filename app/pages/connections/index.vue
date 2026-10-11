<script setup lang="ts">
const route = useRoute()
const { api } = useApi()

const { data, pending, refresh, error } = await useAsyncData('connections', () =>
  api<any>('/api/v1/connections'),
)

const busy = ref('')
const message = ref('')
const messageError = ref(false)
const showGitHub = ref(false)
const showGitLab = ref(false)

const githubForm = reactive({
  token: '',
  displayName: '',
})

const gitlabForm = reactive({
  instanceUrl: 'https://gitlab.com',
  token: '',
  displayName: '',
})

watchEffect(() => {
  if (route.query.error) {
    message.value = String(route.query.error)
    messageError.value = true
  } else if (route.query.connected) {
    message.value = 'Connection established. Repositories are syncing.'
    messageError.value = false
  }
})

async function connectGitHubOAuth() {
  busy.value = 'github-oauth'
  message.value = ''
  messageError.value = false
  try {
    const res = await api<{ authorizeUrl: string }>('/api/v1/connections/github/start', {
      method: 'POST',
      body: { redirectPath: '/connections' },
    })
    await navigateTo(res.authorizeUrl, { external: true })
  } catch (e: any) {
    message.value = e?.data?.message || e?.statusMessage || 'Could not start GitHub OAuth'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

async function connectGitHubToken() {
  busy.value = 'github-token'
  message.value = ''
  messageError.value = false
  try {
    const connection = await api<any>('/api/v1/connections/github/token', {
      method: 'POST',
      body: {
        token: githubForm.token,
        displayName: githubForm.displayName || undefined,
      },
    })
    showGitHub.value = false
    githubForm.token = ''
    message.value = `GitHub connected as ${connection.accountLogin}. Discovering repositories…`
    messageError.value = false
    await refresh()
    if (connection.id) await navigateTo(`/connections/${connection.id}`)
  } catch (e: any) {
    message.value = e?.data?.message || e?.statusMessage || 'GitHub token connection failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

async function connectGitLabToken() {
  busy.value = 'gitlab-token'
  message.value = ''
  messageError.value = false
  try {
    const connection = await api<any>('/api/v1/connections/gitlab/token', {
      method: 'POST',
      body: {
        instanceUrl: gitlabForm.instanceUrl,
        token: gitlabForm.token,
        displayName: gitlabForm.displayName || undefined,
      },
    })
    showGitLab.value = false
    gitlabForm.token = ''
    message.value = `GitLab connected as ${connection.accountLogin}. Discovering repositories…`
    messageError.value = false
    await refresh()
    if (connection.id) await navigateTo(`/connections/${connection.id}`)
  } catch (e: any) {
    message.value = e?.data?.message || e?.statusMessage || 'GitLab connection failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

async function testConnection(id: string) {
  busy.value = `test-${id}`
  try {
    const res = await api<any>(`/api/v1/connections/${id}/test`, { method: 'POST' })
    message.value = res.test?.message || 'Connection validated'
    messageError.value = !res.test?.ok
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Test failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

async function refreshRepos(id: string) {
  busy.value = `refresh-${id}`
  try {
    const res = await api<{ count: number }>(`/api/v1/connections/${id}/refresh`, { method: 'POST' })
    message.value = `Synced ${res.count} repositories`
    messageError.value = false
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Refresh failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

async function disconnect(id: string) {
  if (!confirm('Disconnect this account? Stored tokens will be deleted locally. Registered repositories and workspaces are kept.')) {
    return
  }
  busy.value = `disconnect-${id}`
  try {
    await api(`/api/v1/connections/${id}/disconnect`, { method: 'POST' })
    message.value = 'Connection disconnected'
    messageError.value = false
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Disconnect failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

function statusColor(status: string) {
  if (status === 'active') return 'success'
  if (status === 'error' || status === 'expired') return 'error'
  if (status === 'disconnected') return 'neutral'
  return 'warning'
}

function formatTime(v: string | null | undefined) {
  if (!v) return 'never'
  return new Date(v).toLocaleString()
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="font-display text-3xl tracking-tight">Connections</h1>
        <p class="mt-1 text-sm opacity-70">
          Connect with a personal access token (recommended), discover repositories, and clone selected workspaces.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton icon="i-lucide-github" @click="showGitHub = true">
          Connect GitHub
        </UButton>
        <UButton icon="i-lucide-gitlab" color="neutral" variant="soft" @click="showGitLab = true">
          Connect GitLab
        </UButton>
      </div>
    </div>

    <UAlert
      v-if="message"
      :color="messageError ? 'error' : 'success'"
      :title="message"
      variant="subtle"
    />

    <div class="aw-panel rounded-xl p-4 text-sm opacity-80">
      <p class="font-medium">How to connect</p>
      <ul class="mt-2 list-disc space-y-1 pl-5 opacity-80">
        <li>
          <strong>GitHub:</strong> paste a classic PAT with
          <code>repo</code> scope (or a fine-grained PAT with Contents, Issues, and Pull requests read/write).
          Browser OAuth is optional when
          <code>GITHUB_OAUTH_CLIENT_*</code> is configured.
        </li>
        <li>
          <strong>GitLab:</strong> enter your server URL (e.g. <code>https://gitlab.com</code>) and a personal
          access token with the <code>api</code> scope.
        </li>
      </ul>
    </div>

    <div v-if="pending && !data" class="grid gap-4 md:grid-cols-2">
      <div v-for="i in 2" :key="i" class="aw-panel h-40 animate-pulse rounded-xl" />
    </div>
    <div v-else-if="error" class="aw-panel rounded-xl p-8 text-center text-sm text-red-700 dark:text-red-300">
      Failed to load connections.
    </div>
    <div v-else-if="!data?.items?.length" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">
      No forge connections yet. Connect GitHub or GitLab to discover repositories.
    </div>
    <div v-else class="grid gap-4 md:grid-cols-2">
      <div v-for="c in data.items" :key="c.id" class="aw-panel space-y-3 rounded-xl p-4">
        <div class="flex items-start justify-between gap-2">
          <div>
            <h2 class="font-display text-xl">{{ c.displayName || c.accountLogin || c.provider }}</h2>
            <p class="text-sm opacity-60">
              {{ c.provider }} · {{ c.accountLogin || 'unknown account' }}
            </p>
            <p class="text-xs opacity-50">{{ c.instanceUrl }}</p>
          </div>
          <UBadge :color="statusColor(c.status)" variant="subtle">{{ c.status }}</UBadge>
        </div>
        <p class="text-sm opacity-70">Last sync: {{ formatTime(c.lastSyncAt) }}</p>
        <p class="text-sm opacity-70">Last validated: {{ formatTime(c.lastValidatedAt) }}</p>
        <p v-if="c.lastError" class="text-sm text-red-700 dark:text-red-300">{{ c.lastError }}</p>
        <div class="flex flex-wrap gap-2">
          <UButton size="sm" variant="soft" :to="`/connections/${c.id}`">Repositories</UButton>
          <UButton size="sm" variant="ghost" :loading="busy === `test-${c.id}`" @click="testConnection(c.id)">
            Test
          </UButton>
          <UButton size="sm" variant="ghost" :loading="busy === `refresh-${c.id}`" @click="refreshRepos(c.id)">
            Refresh
          </UButton>
          <UButton
            size="sm"
            color="error"
            variant="ghost"
            :loading="busy === `disconnect-${c.id}`"
            :disabled="c.status === 'disconnected'"
            @click="disconnect(c.id)"
          >
            Disconnect
          </UButton>
        </div>
      </div>
    </div>

    <UModal v-model:open="showGitHub" title="Connect GitHub">
      <template #body>
        <div class="space-y-4">
          <form class="space-y-3" @submit.prevent="connectGitHubToken">
            <UFormField label="Personal access token" required>
              <UInput
                v-model="githubForm.token"
                type="password"
                autocomplete="off"
                class="w-full"
                placeholder="ghp_… or github_pat_…"
              />
            </UFormField>
            <UFormField label="Connection name (optional)">
              <UInput v-model="githubForm.displayName" class="w-full" placeholder="Personal GitHub" />
            </UFormField>
            <p class="text-xs opacity-60">
              Create at GitHub → Settings → Developer settings → Personal access tokens.
              Classic: enable <code>repo</code>. Token is stored encrypted and never shown again.
            </p>
            <UButton type="submit" block :loading="busy === 'github-token'" :disabled="!githubForm.token">
              Connect with token
            </UButton>
          </form>

          <div v-if="data?.oauth?.githubConfigured" class="border-t border-[var(--aw-line)] pt-4">
            <p class="mb-2 text-sm opacity-70">Or sign in with GitHub OAuth</p>
            <UButton
              variant="soft"
              block
              icon="i-lucide-github"
              :loading="busy === 'github-oauth'"
              @click="connectGitHubOAuth"
            >
              Sign in with GitHub
            </UButton>
          </div>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="showGitLab" title="Connect GitLab">
      <template #body>
        <form class="space-y-3" @submit.prevent="connectGitLabToken">
          <UFormField label="GitLab server URL" required>
            <UInput v-model="gitlabForm.instanceUrl" class="w-full" placeholder="https://gitlab.com" />
          </UFormField>
          <UFormField label="Personal access token" required>
            <UInput
              v-model="gitlabForm.token"
              type="password"
              autocomplete="off"
              class="w-full"
              placeholder="glpat-…"
            />
          </UFormField>
          <UFormField label="Connection name (optional)">
            <UInput v-model="gitlabForm.displayName" class="w-full" placeholder="Work GitLab" />
          </UFormField>
          <p class="text-xs opacity-60">
            Create a token in GitLab → Preferences → Access Tokens with the <code>api</code> scope.
            Self-managed hosts may need <code>GITLAB_TRUSTED_HOSTS</code>. Token is stored encrypted.
          </p>
          <div class="flex justify-end gap-2">
            <UButton type="button" variant="ghost" @click="showGitLab = false">Cancel</UButton>
            <UButton type="submit" :loading="busy === 'gitlab-token'" :disabled="!gitlabForm.token">
              Connect
            </UButton>
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>
