<script setup lang="ts">
const { t } = useI18n()

const contact = CONTACT_LINKS.find((l) => l.id === 'email')
</script>

<template>
  <footer
    class="mt-auto border-t border-[var(--aw-line)] px-4 py-4 text-xs opacity-70 md:px-8"
    role="contentinfo"
  >
    <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <p>
        <span class="font-medium opacity-90">{{ SITE.name }}</span>
        · © {{ SITE.copyrightYear }} {{ SITE.copyrightHolder }}
      </p>
      <nav class="flex flex-wrap items-center gap-x-4 gap-y-1" :aria-label="t('layout.footerNav')">
        <NuxtLink
          to="/how-it-works"
          class="underline-offset-2 hover:underline hover:opacity-100"
        >
          {{ t('footer.howItWorks') }}
        </NuxtLink>
        <NuxtLink
          to="/about"
          class="underline-offset-2 hover:underline hover:opacity-100"
        >
          {{ t('footer.about') }}
        </NuxtLink>
        <a
          :href="SITE.repositoryUrl"
          class="underline-offset-2 hover:underline hover:opacity-100"
          rel="noopener noreferrer"
          target="_blank"
        >
          {{ t('footer.repository') }}
        </a>
        <a
          :href="SITE.licenseUrl"
          class="underline-offset-2 hover:underline hover:opacity-100"
          rel="noopener noreferrer"
          target="_blank"
        >
          {{ t('footer.license') }}
          <span v-if="SITE.licenseSpdx"> ({{ SITE.licenseSpdx }})</span>
        </a>
        <a
          v-if="contact && linkIsConfigured(contact)"
          :href="contact.href"
          class="underline-offset-2 hover:underline hover:opacity-100"
        >
          {{ t('footer.contact') }}
        </a>
      </nav>
    </div>
  </footer>
</template>
