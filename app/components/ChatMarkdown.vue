<script setup lang="ts">
import { renderChatMarkdown } from '../utils/chat-markdown'
import 'highlight.js/styles/github-dark.css'
const props = defineProps<{ content: string }>()
const blocks = computed(() => renderChatMarkdown(props.content))
</script>

<template>
  <div class="chat-markdown min-w-0 break-words">
    <template v-for="(block, index) in blocks" :key="`${index}-${block.type}`">
      <!-- HTML comes only from the Markdown parser with raw HTML disabled. -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="block.type === 'html'" v-html="block.content" />
      <ClientOnly v-else>
        <ChatMermaid :source="block.content" />
        <template #fallback><pre><code>{{ block.content }}</code></pre></template>
      </ClientOnly>
    </template>
  </div>
</template>

<style scoped>
.chat-markdown :deep(h1), .chat-markdown :deep(h2), .chat-markdown :deep(h3),
.chat-markdown :deep(h4), .chat-markdown :deep(h5), .chat-markdown :deep(h6) { font-weight: 650; line-height: 1.3; margin: 1.2em 0 .6em; }
.chat-markdown :deep(h1) { font-size: 1.6em; }
.chat-markdown :deep(h2) { font-size: 1.35em; }
.chat-markdown :deep(h3) { font-size: 1.15em; }
.chat-markdown :deep(p), .chat-markdown :deep(ul), .chat-markdown :deep(ol), .chat-markdown :deep(blockquote) { margin: .7em 0; }
.chat-markdown :deep(ul) { list-style: disc; padding-inline-start: 1.6em; }
.chat-markdown :deep(ol) { list-style: decimal; padding-inline-start: 1.6em; }
.chat-markdown :deep(li) { margin: .25em 0; }
.chat-markdown :deep(a) { color: var(--aw-accent); text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
.chat-markdown :deep(blockquote) { border-inline-start: 3px solid var(--aw-line); padding-inline-start: 1em; opacity: .8; }
.chat-markdown :deep(pre) { max-width: 100%; overflow-x: auto; padding: 1em; border-radius: .6em; background: #0d1117; color: #e6edf3; direction: ltr; text-align: left; margin: .8em 0; }
.chat-markdown :deep(code) { font-family: ui-monospace, monospace; font-size: .9em; }
.chat-markdown :deep(:not(pre) > code) { background: color-mix(in oklab, currentColor 9%, transparent); border-radius: .25em; padding: .15em .3em; }
.chat-markdown :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 1em 0; }
.chat-markdown :deep(th), .chat-markdown :deep(td) { border: 1px solid var(--aw-line); padding: .5em .8em; text-align: start; }
.chat-markdown :deep(th) { font-weight: 650; background: color-mix(in oklab, currentColor 5%, transparent); }
.chat-markdown :deep(hr) { margin: 1.2em 0; border-color: var(--aw-line); }
.chat-markdown :deep(img) { max-width: 100%; height: auto; }
.chat-markdown :deep(div > :first-child) { margin-top: 0; }
.chat-markdown :deep(div > :last-child) { margin-bottom: 0; }
</style>
