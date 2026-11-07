<script setup lang="ts">
const props = defineProps<{ messages: Array<{ role: string, content: string }>, disabled?: boolean }>()
const { t } = useI18n()
const transcript = computed(() => props.messages.map(message => {
  const speaker = message.role === 'user' ? t('createTasks.you') : message.role === 'assistant' ? t('createTasks.assistant') : message.role
  return `## ${speaker}\n\n${message.content}`
}).join('\n\n---\n\n'))
</script>

<template>
  <MessageCopyButton :content="transcript" :label="t('chat.copyConversation')" :disabled="disabled || !messages.length" size="sm" />
</template>
