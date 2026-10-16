<script setup lang="ts">
definePageMeta({ layout: 'auth' })

const { api } = useApi()
const username = ref('')
const email = ref('')
const password = ref('')
const confirm = ref('')
const bootstrapSecret = ref('')
const loading = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  if (!email.value.trim() || !email.value.includes('@')) {
    error.value = 'A valid email is required'
    return
  }
  if (password.value !== confirm.value) {
    error.value = 'Passwords do not match'
    return
  }
  if (password.value.length < 12) {
    error.value = 'Password must be at least 12 characters'
    return
  }
  loading.value = true
  try {
    await api('/api/v1/auth/bootstrap', {
      method: 'POST',
      body: {
        username: username.value,
        email: email.value.trim(),
        password: password.value,
        bootstrapSecret: bootstrapSecret.value,
      },
    })
    await navigateTo('/')
  } catch (e: any) {
    error.value = e?.data?.message || e?.statusMessage || 'Setup failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div>
    <h1 class="font-display text-3xl tracking-tight">First-run setup</h1>
    <p class="mt-2 text-sm opacity-70">
      Create the initial administrator. No default password is shipped.
    </p>

    <form class="mt-8 space-y-4" @submit.prevent="submit">
      <UFormField
        label="Bootstrap secret"
        hint="cat INITIAL_ADMIN_BOOTSTRAP_SECRET.txt  (or grep INITIAL_ADMIN_BOOTSTRAP_SECRET .env)"
        required
      >
        <UInput v-model="bootstrapSecret" type="password" class="w-full" />
      </UFormField>
      <UFormField label="Admin username" required>
        <UInput v-model="username" autocomplete="username" class="w-full" />
      </UFormField>
      <UFormField
        label="Admin email"
        hint="Used for CodeGraph Pro waitlist signup when the worker configures CodeGraph."
        required
      >
        <UInput v-model="email" type="email" autocomplete="email" class="w-full" />
      </UFormField>
      <UFormField label="Password (min 12)" required>
        <UInput v-model="password" type="password" autocomplete="new-password" class="w-full" />
      </UFormField>
      <UFormField label="Confirm password" required>
        <UInput v-model="confirm" type="password" autocomplete="new-password" class="w-full" />
      </UFormField>
      <p v-if="error" class="text-sm text-red-600" role="alert">{{ error }}</p>
      <UButton type="submit" block :loading="loading">Create administrator</UButton>
    </form>
  </div>
</template>
