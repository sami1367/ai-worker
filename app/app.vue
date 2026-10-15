<script setup lang="ts">
const { locale, dir } = useI18n()

useHead({
  htmlAttrs: {
    lang: () => locale.value,
    dir: () => dir.value,
  },
})
</script>

<template>
  <UApp>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
