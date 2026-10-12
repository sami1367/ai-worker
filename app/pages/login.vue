<script setup lang="ts">
definePageMeta({ layout: 'auth' })

const { api } = useApi()
const username = ref('')
const password = ref('')
const showPassword = ref(false)
const loading = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  loading.value = true
  // Keep type=password during submit so browsers can capture credentials.
  showPassword.value = false
  try {
    await api('/api/v1/auth/login', {
      method: 'POST',
      body: { username: username.value, password: password.value },
    })

    // Full navigation (not SPA soft nav) lets password managers finalize "Save password".
    if (import.meta.client) {
      window.location.assign('/')
      return
    }
    await navigateTo('/')
  } catch (e: any) {
    error.value = e?.data?.message || e?.statusMessage || 'Invalid username or password'
    loading.value = false
  }
}
</script>

<template>
  <div>
    <h1 class="font-display text-3xl tracking-tight">AI Worker Platform</h1>
    <p class="mt-2 text-sm opacity-70">Sign in to manage automation</p>

    <form
      class="mt-8 space-y-4"
      method="post"
      action="/api/v1/auth/login"
      @submit.prevent="submit"
    >
      <UFormField label="Username" name="username" required>
        <UInput
          v-model="username"
          name="username"
          autocomplete="username"
          class="w-full"
        />
      </UFormField>
      <UFormField label="Password" name="password" required>
        <UInput
          v-model="password"
          name="password"
          :type="showPassword ? 'text' : 'password'"
          autocomplete="current-password"
          class="w-full"
          :ui="{ trailing: 'pe-1' }"
        >
          <template #trailing>
            <UButton
              type="button"
              color="neutral"
              variant="ghost"
              size="sm"
              :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
              tabindex="-1"
              @click="showPassword = !showPassword"
            />
          </template>
        </UInput>
      </UFormField>

      <p v-if="error" class="text-sm text-red-600 dark:text-red-400" role="alert">{{ error }}</p>

      <UButton type="submit" block :loading="loading" color="primary">
        Sign in
      </UButton>
    </form>
  </div>
</template>
