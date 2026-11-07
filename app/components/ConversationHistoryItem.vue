<script setup lang="ts">
defineProps<{ title: string, updatedAt: string, active?: boolean, disabled?: boolean }>()
const emit = defineEmits<{ open: [], delete: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="mb-1 flex items-center gap-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5" :class="active ? 'bg-black/5 dark:bg-white/10' : ''">
    <button type="button" class="min-w-0 flex-1 rounded-lg p-2 text-start text-sm" :disabled="disabled" :aria-current="active ? 'true' : undefined" @click="emit('open')">
      <span class="block truncate">{{ title }}</span>
      <time class="text-xs opacity-50">{{ new Date(updatedAt).toLocaleDateString() }}</time>
    </button>
    <UButton type="button" size="xs" variant="ghost" color="neutral" icon="i-lucide-trash-2" class="me-1 shrink-0 hover:text-red-500" :disabled="disabled" :aria-label="t('chat.deleteConversationLabel', { title })" :title="t('chat.deleteConversation')" @click="emit('delete')" />
  </div>
</template>
