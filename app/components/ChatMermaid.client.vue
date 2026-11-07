<script setup lang="ts">
import DOMPurify from 'dompurify'
const props = defineProps<{ source: string }>()
const id = `diagram-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const svg = ref('')
const error = ref('')
const loading = ref(true)
let generation = 0

watch(() => props.source, async (source) => {
  const current = ++generation
  loading.value = true
  error.value = ''
  svg.value = ''
  try {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: 'default',
      htmlLabels: false, flowchart: { htmlLabels: false },
      suppressErrorRendering: true, maxTextSize: 20_000, maxEdges: 300,
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart', 'suppressErrorRendering'],
    })
    const result = await mermaid.render(`${id}-${current}`, source)
    if (current !== generation) return
    svg.value = DOMPurify.sanitize(result.svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject', 'a', 'image'],
    })
  } catch {
    if (current === generation) error.value = 'This diagram could not be rendered. Its source is shown below.'
  } finally {
    if (current === generation) loading.value = false
  }
}, { immediate: true })
onBeforeUnmount(() => { generation++ })
</script>

<template>
  <figure class="my-3 min-w-0" aria-label="Mermaid diagram">
    <p v-if="loading" class="text-xs opacity-60" role="status">Rendering diagram…</p>
    <!-- SVG is sanitized after Mermaid's strict rendering. -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-if="svg" class="overflow-x-auto rounded-lg bg-white p-3 text-gray-900 [&_svg]:h-auto [&_svg]:max-w-full" v-html="svg" />
    <p v-if="error" class="text-xs opacity-70" role="status">{{ error }}</p>
    <details :open="Boolean(error)" class="mt-2 text-xs">
      <summary class="cursor-pointer opacity-70">Diagram source</summary>
      <pre class="overflow-x-auto"><code>{{ source }}</code></pre>
    </details>
  </figure>
</template>
