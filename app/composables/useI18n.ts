import type { I18nParams } from '~/plugins/i18n'
import type { LocaleCode, MessageKey } from '~/locales'
import { LOCALES } from '~/locales'

export function useI18n() {
  const { $i18n } = useNuxtApp()

  const locale = computed({
    get: () => ($i18n?.locale?.value ?? 'en') as LocaleCode,
    set: (code: LocaleCode) => $i18n?.setLocale?.(code),
  })

  const dir = computed(() => $i18n?.dir?.value ?? 'ltr')
  const intlLocale = computed(() => $i18n?.intlLocale?.value ?? 'en-US')
  const locales = $i18n?.locales ?? LOCALES
  const currentLocaleMeta = computed(() => $i18n?.currentLocaleMeta?.value ?? LOCALES[0])

  function t(key: MessageKey | string, params?: I18nParams): string {
    return $i18n?.t?.(key, params) ?? key
  }

  function setLocale(code: LocaleCode) {
    $i18n?.setLocale?.(code)
  }

  return {
    locale,
    dir,
    intlLocale,
    locales,
    currentLocaleMeta,
    t,
    setLocale,
  }
}
