<script setup lang="ts">
const route = useRoute()
const { api } = useApi()

const { data, pending, refresh, error } = await useAsyncData('connections', () =>
  api<any>('/api/v1/connections'),
)

const { data: sshKey } = await useAsyncData('platform-ssh-key', () =>
  api<{
    publicKey: string
    fingerprint: string
    keyType: string
    comment: string
    privateKeyPresent: boolean
  }>('/api/v1/platform/ssh-key'),
)

const busy = ref('')
const message = ref('')
const messageError = ref(false)
const showGitHub = ref(false)
const showGitLab = ref(false)
const sshCopied = ref(false)

async function copySshPublicKey() {
  if (!sshKey.value?.publicKey) return
  try {
    await navigator.clipboard.writeText(sshKey.value.publicKey)
    sshCopied.value = true
    setTimeout(() => { sshCopied.value = false }, 2000)
  } catch {
    message.value = 'Could not copy public key — select and copy manually'
    messageError.value = true
  }
}

const githubForm = reactive({
  token: '',
  displayName: '',
  enableRepositories: true,
})

const gitlabForm = reactive({
  instanceUrl: 'https://gitlab.com',
  token: '',
  displayName: '',
  enableRepositories: true,
})

watchEffect(() => {
  if (route.query.error) {
    message.value = String(route.query.error)
    messageError.value = true
  } else if (route.query.connected) {
    message.value = 'Connection established. Repositories sync and register automatically.'
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
    const enableRepositories = githubForm.enableRepositories
    const connection = await api<any>('/api/v1/connections/github/token', {
      method: 'POST',
      body: {
        token: githubForm.token,
        displayName: githubForm.displayName || undefined,
        enableRepositories,
      },
    })
    showGitHub.value = false
    githubForm.token = ''
    githubForm.enableRepositories = true
    message.value = enableRepositories
      ? `GitHub connected as ${connection.accountLogin}. Repos registered and enabled.`
      : `GitHub connected as ${connection.accountLogin}. Repos registered (disabled until you enable them).`
    messageError.value = false
    await refresh()
    await refreshNuxtData('setup-readiness')
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
    const enableRepositories = gitlabForm.enableRepositories
    const connection = await api<any>('/api/v1/connections/gitlab/token', {
      method: 'POST',
      body: {
        instanceUrl: gitlabForm.instanceUrl,
        token: gitlabForm.token,
        displayName: gitlabForm.displayName || undefined,
        enableRepositories,
      },
    })
    showGitLab.value = false
    gitlabForm.token = ''
    gitlabForm.enableRepositories = true
    message.value = enableRepositories
      ? `GitLab connected as ${connection.accountLogin}. Repos registered and enabled.`
      : `GitLab connected as ${connection.accountLogin}. Repos registered (disabled until you enable them).`
    messageError.value = false
    await refresh()
    await refreshNuxtData('setup-readiness')
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
    await refreshNuxtData('setup-readiness')
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
    await refreshNuxtData('setup-readiness')
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
          Connect with a personal access token. Clone/push uses the token over HTTPS when the forge allows it.
          The platform SSH key below is optional (needed only if git-over-HTTPS is disabled).
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

    <div class="aw-panel space-y-3 rounded-xl p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="font-medium">Platform SSH public key <span class="opacity-60">(optional)</span></p>
          <p class="mt-1 text-sm opacity-70">
            Generated once on this install; all workers share it. Not required when the forge allows
            HTTPS git with your token (GitLab Admin → Enabled Git access protocols → Both or HTTP).
            Add this public key only if git-over-HTTPS is disabled. The private key stays on the
            data volume and is never shown.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton size="sm" variant="soft" icon="i-lucide-copy" :disabled="!sshKey?.publicKey" @click="copySshPublicKey">
            {{ sshCopied ? 'Copied' : 'Copy public key' }}
          </UButton>
        </div>
      </div>
      <p v-if="sshKey?.fingerprint" class="text-xs opacity-50">
        {{ sshKey.keyType }} · {{ sshKey.fingerprint }}
      </p>
      <pre
        class="max-h-28 overflow-auto rounded-lg bg-black/5 p-3 text-xs break-all whitespace-pre-wrap dark:bg-white/5"
      >{{ sshKey?.publicKey || 'Generating platform SSH key…' }}</pre>
      <ul class="list-disc space-y-1 pl-5 text-sm opacity-70">
        <li>
          <strong>GitLab:</strong> Preferences → SSH Keys → paste the key → Add key
          (or Project → Settings → Repository → Deploy keys with write access).
        </li>
        <li>
          <strong>GitHub:</strong> Settings → SSH and GPG keys → New SSH key → paste the key.
        </li>
      </ul>
    </div>

    <div class="aw-panel rounded-xl p-4 text-sm opacity-80">
      <p class="font-medium">How to connect</p>
      <ul class="mt-2 list-disc space-y-1 pl-5 opacity-80">
        <li>
          <strong>SSH key:</strong> optional. Prefer enabling HTTPS git on the forge so the token
          can clone. Add the public key above only if the forge is SSH-only for git.
        </li>
        <li>
          <strong>GitHub:</strong> use a classic PAT with the full <code>repo</code> scope
          (<code>public_repo</code> alone only lists public repositories). Fine-grained PATs need
          Repository access to those private repos (for org private repos, create the token with that
          organization as the resource owner) plus Metadata/Contents/Issues/PRs.
          Browser OAuth is optional when <code>GITHUB_OAUTH_CLIENT_*</code> is configured.
        </li>
        <li>
          <strong>GitLab:</strong> enter your server URL (e.g. <code>https://gitlab.com</code>) and a personal
          access token with the <code>api</code> scope (<code>read_api</code> is the minimum to list private projects).
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
            <UCheckbox
              v-model="githubForm.enableRepositories"
              label="Enable all discovered repositories"
              description="When off, repos are registered but stay disabled until you enable them on Repositories."
            />
            <p class="text-xs opacity-60">
              Recommended: GitHub → Settings → Developer settings →
              <strong>Personal access tokens (classic)</strong> → enable the full <code>repo</code> scope.
              Fine-grained tokens often miss private/org repos unless Repository access is
              <em>All repositories</em> and org private repos use the organization as resource owner.
              Token is stored encrypted and never shown again.
              Optional: add the platform SSH public key from this page if HTTPS git clone is unavailable.
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
          <UCheckbox
            v-model="gitlabForm.enableRepositories"
            label="Enable all discovered repositories"
            description="When off, repos are registered but stay disabled until you enable them on Repositories."
          />
          <p class="text-xs opacity-60">
            Create a token in GitLab → Preferences → Access Tokens with the <code>api</code> scope
            (<code>read_api</code> alone can list private projects, but worker ops need <code>api</code>).
            Self-managed hosts may need <code>GITLAB_TRUSTED_HOSTS</code>. Token is stored encrypted.
            Prefer GitLab Admin → Enabled Git access protocols → <strong>Both</strong> or <strong>HTTP</strong>
            so this token can clone over HTTPS. SSH public key on this page is optional fallback.
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
