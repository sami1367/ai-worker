<script setup lang="ts">
const { t } = useI18n()

const serviceItemKeys = [
  'about.services.item1',
  'about.services.item2',
  'about.services.item3',
  'about.services.item4',
  'about.services.item5',
] as const
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-8 aw-fade-in">
    <div>
      <h1 class="font-display text-3xl tracking-tight">
        {{ t('about.title') }}
      </h1>
      <p class="mt-1 text-sm opacity-70">
        {{ t('about.subtitle') }}
      </p>
    </div>

    <section class="aw-panel space-y-3 rounded-xl p-5" aria-labelledby="about-product">
      <h2 id="about-product" class="font-display text-xl">
        {{ t('about.product.heading') }}
      </h2>
      <p class="text-sm leading-relaxed opacity-90">
        {{ t('about.product.p1') }}
      </p>
      <p class="text-sm leading-relaxed opacity-90">
        {{ t('about.product.p2') }}
      </p>
    </section>

    <section class="aw-panel space-y-3 rounded-xl p-5" aria-labelledby="about-services">
      <h2 id="about-services" class="font-display text-xl">
        {{ t('about.services.heading') }}
      </h2>
      <p class="text-sm leading-relaxed opacity-90">
        {{ t('about.services.intro') }}
      </p>
      <ul class="list-disc space-y-2 ps-5 text-sm leading-relaxed opacity-90">
        <li v-for="key in serviceItemKeys" :key="key">
          {{ t(key) }}
        </li>
      </ul>
    </section>

    <section class="aw-panel space-y-4 rounded-xl p-5" aria-labelledby="about-contact">
      <h2 id="about-contact" class="font-display text-xl">
        {{ t('about.contact.heading') }}
      </h2>
      <ul class="space-y-3 text-sm">
        <li
          v-for="link in CONTACT_LINKS"
          :key="link.id"
          class="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3"
        >
          <span class="shrink-0 font-medium sm:w-40">{{ link.label }}</span>
          <a
            v-if="linkIsConfigured(link)"
            :href="link.href"
            class="text-[var(--aw-accent)] underline-offset-2 hover:underline"
            :rel="link.href.startsWith('http') ? 'noopener noreferrer' : undefined"
            :target="link.href.startsWith('http') ? '_blank' : undefined"
          >
            {{ link.href.replace(/^mailto:/, '') }}
          </a>
          <span
            v-else
            class="rounded-md border border-dashed border-[var(--aw-line)] px-2 py-1 text-xs opacity-70"
            role="status"
          >
            {{ displayHref(link) }}
          </span>
        </li>
      </ul>

      <div class="border-t border-[var(--aw-line)] pt-4">
        <p class="mb-2 text-xs font-medium uppercase tracking-wide opacity-60">
          {{ t('about.collaboration') }}
        </p>
        <ul class="flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:gap-x-4 sm:gap-y-2">
          <li v-for="link in COLLABORATION_LINKS" :key="link.id">
            <a
              v-if="linkIsConfigured(link)"
              :href="link.href"
              class="inline-flex items-center gap-1.5 text-[var(--aw-accent)] underline-offset-2 hover:underline"
              :rel="link.href.startsWith('http') ? 'noopener noreferrer' : undefined"
              :target="link.href.startsWith('http') ? '_blank' : undefined"
            >
              <UIcon
                :name="link.id === 'issues' ? 'i-lucide-circle-alert' : link.id === 'contribute' ? 'i-lucide-git-pull-request' : 'i-lucide-briefcase'"
                class="size-3.5 shrink-0"
                aria-hidden="true"
              />
              {{ link.label }}
            </a>
            <span
              v-else
              class="rounded-md border border-dashed border-[var(--aw-line)] px-2 py-1 text-xs opacity-70"
              role="status"
            >
              {{ link.label }}: {{ displayHref(link) }}
            </span>
          </li>
        </ul>
      </div>
    </section>

    <section class="aw-panel space-y-3 rounded-xl p-5" aria-labelledby="about-license">
      <h2 id="about-license" class="font-display text-xl">
        {{ t('about.license.heading') }}
      </h2>
      <template v-if="SITE.licenseSpdx">
        <p class="text-sm leading-relaxed opacity-90">
          <span class="font-medium">{{ SITE.licenseName }}</span>
          ({{ SITE.licenseSpdx }}).
          {{ SITE.licenseSummary }}
        </p>
        <p class="text-sm">
          <a
            :href="SITE.licenseUrl"
            class="inline-flex items-center gap-1.5 text-[var(--aw-accent)] underline-offset-2 hover:underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            <UIcon name="i-lucide-scale" class="size-3.5" aria-hidden="true" />
            {{ t('about.license.view') }}
          </a>
        </p>
      </template>
      <p v-else class="text-sm opacity-70" role="status">
        {{ t('about.license.pending') }}
      </p>
    </section>
  </div>
</template>
