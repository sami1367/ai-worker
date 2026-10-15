<script setup lang="ts">
import type { LocaleCode } from '~/locales'

const { locale, locales, t, setLocale } = useI18n()

const items = computed(() =>
  locales.map((l) => ({
    label: `${l.flag} ${l.nativeName}`,
    value: l.code,
  })),
)

function onChange(value: LocaleCode | string | undefined | null) {
  if (value) setLocale(value as LocaleCode)
}
</script>

<template>
  <USelect
    :model-value="locale"
    :items="items"
    class="min-w-[11.5rem]"
    size="sm"
    :aria-label="t('layout.language')"
    @update:model-value="onChange"
  />
</template>
