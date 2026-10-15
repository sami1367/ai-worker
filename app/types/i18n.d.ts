import type { ComputedRef, Ref } from 'vue'
import type { I18nParams } from '~/plugins/i18n'
import type { LocaleCode, LocaleMeta, MessageKey } from '~/locales'

interface AppI18n {
  locale: Ref<LocaleCode>
  dir: ComputedRef<'ltr' | 'rtl'>
  intlLocale: ComputedRef<string>
  locales: LocaleMeta[]
  currentLocaleMeta: ComputedRef<LocaleMeta>
  t: (key: MessageKey | string, params?: I18nParams) => string
  setLocale: (code: LocaleCode) => void
}

declare module '#app' {
  interface NuxtApp {
    $i18n: AppI18n
  }
}

declare module 'vue' {
  interface ComponentCustomProperties {
    $i18n: AppI18n
  }
}

export {}
