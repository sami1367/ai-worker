<script setup lang="ts">
const props = defineProps<{ content: string, label?: string, disabled?: boolean, size?: 'xs' | 'sm' | 'md' }>()
const { t } = useI18n()
const status = ref<'idle' | 'copied' | 'failed'>('idle')
const copying = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | null = null

// Clipboard API requires HTTPS or localhost; support self-hosted HTTP installations too.
function copyWithSelection() {
  const previousFocus = document.activeElement as HTMLElement | null
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const textarea = document.createElement('textarea')
  textarea.value = props.content
  textarea.readOnly = true
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  document.body.appendChild(textarea)
  try {
    textarea.select()
    if (!document.execCommand('copy')) throw new Error('Copy unavailable')
  } finally {
    textarea.remove()
    previousFocus?.focus({ preventScroll: true })
    selection?.removeAllRanges()
    for (const range of ranges) selection?.addRange(range)
  }
}
async function copy() {
  if (copying.value || props.disabled) return
  copying.value = true
  if (resetTimer) clearTimeout(resetTimer)
  try {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(props.content)
    } catch { copyWithSelection() }
    status.value = 'copied'
  } catch { status.value = 'failed' } finally {
    copying.value = false
    resetTimer = setTimeout(() => { status.value = 'idle' }, 2500)
  }
}
onBeforeUnmount(() => { if (resetTimer) clearTimeout(resetTimer) })
</script>

<template>
  <UButton
    type="button"
    variant="ghost"
    color="neutral"
    :size="size || 'xs'"
    :icon="status === 'copied' ? 'i-lucide-check' : status === 'failed' ? 'i-lucide-circle-alert' : 'i-lucide-copy'"
    :disabled="copying || disabled"
    :aria-label="status === 'idle' ? (label || t('chat.copy')) : t(status === 'copied' ? 'chat.copied' : 'chat.copyFailed')"
    @click="copy"
  >
    <span aria-live="polite">{{ status === 'idle' ? (label || t('chat.copy')) : t(status === 'copied' ? 'chat.copied' : 'chat.copyFailed') }}</span>
  </UButton>
</template>
