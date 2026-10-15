/**
 * Lightweight client i18n — English default, 12 UI locales, RTL for fa/ar.
 */
import {
  DEFAULT_LOCALE,
  LOCALE_INTL,
  LOCALE_STORAGE_KEY,
  LOCALES,
  RTL_LOCALES,
  isLocaleCode,
  messages,
  type LocaleCode,
  type MessageKey,
} from '~/locales'

export type I18nParams = Record<string, string | number>

function interpolate(template: string, params?: I18nParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key]
    return value == null ? match : String(value)
  })
}

function applyDocumentLocale(code: LocaleCode) {
  if (!import.meta.client) return
  const dir = RTL_LOCALES.has(code) ? 'rtl' : 'ltr'
  document.documentElement.lang = code
  document.documentElement.dir = dir
}

export default defineNuxtPlugin(() => {
  const locale = useState<LocaleCode>('locale', () => DEFAULT_LOCALE)

  if (import.meta.client) {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocaleCode(saved)) {
      locale.value = saved
    }
    applyDocumentLocale(locale.value)
  }

  function t(key: MessageKey | string, params?: I18nParams): string {
    const table = messages[locale.value] || messages.en
    const raw = table[key as MessageKey] || messages.en[key as MessageKey] || key
    return interpolate(raw, params)
  }

  function setLocale(code: LocaleCode) {
    if (!isLocaleCode(code)) return
    locale.value = code
    if (import.meta.client) {
      localStorage.setItem(LOCALE_STORAGE_KEY, code)
      applyDocumentLocale(code)
    }
  }

  const dir = computed(() => (RTL_LOCALES.has(locale.value) ? 'rtl' : 'ltr'))
  const intlLocale = computed(() => LOCALE_INTL[locale.value] || LOCALE_INTL.en)
  const currentLocaleMeta = computed(
    () => LOCALES.find((l) => l.code === locale.value) || LOCALES[0],
  )

  return {
    provide: {
      i18n: {
        locale,
        dir,
        intlLocale,
        locales: LOCALES,
        currentLocaleMeta,
        t,
        setLocale,
      },
    },
  }
})
