import type { Messages } from './en'
import { en } from './en'
import { fa } from './fa'
import { es } from './es'
import { fr } from './fr'
import { de } from './de'
import { zh } from './zh'
import { pt } from './pt'
import { ar } from './ar'
import { hi } from './hi'
import { ru } from './ru'
import { ja } from './ja'
import { tr } from './tr'

export type { MessageKey, Messages } from './en'
export { en } from './en'

export const LOCALE_CODES = [
  'en',
  'fa',
  'es',
  'fr',
  'de',
  'zh',
  'pt',
  'ar',
  'hi',
  'ru',
  'ja',
  'tr',
] as const

export type LocaleCode = (typeof LOCALE_CODES)[number]

export const RTL_LOCALES = new Set<LocaleCode>(['fa', 'ar'])

/** BCP 47 tags for Intl formatting */
export const LOCALE_INTL: Record<LocaleCode, string> = {
  en: 'en-US',
  fa: 'fa-IR',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  zh: 'zh-CN',
  pt: 'pt-BR',
  ar: 'ar-SA',
  hi: 'hi-IN',
  ru: 'ru-RU',
  ja: 'ja-JP',
  tr: 'tr-TR',
}

export type LocaleMeta = {
  code: LocaleCode
  /** English label for accessibility */
  name: string
  /** Native endonym shown in the switcher */
  nativeName: string
  flag: string
  dir: 'ltr' | 'rtl'
}

export const LOCALES: LocaleMeta[] = [
  { code: 'en', name: 'English', nativeName: 'English', flag: '🇬🇧', dir: 'ltr' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی', flag: '🇮🇷', dir: 'rtl' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', flag: '🇪🇸', dir: 'ltr' },
  { code: 'fr', name: 'French', nativeName: 'Français', flag: '🇫🇷', dir: 'ltr' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', flag: '🇩🇪', dir: 'ltr' },
  { code: 'zh', name: 'Chinese (Simplified)', nativeName: '简体中文', flag: '🇨🇳', dir: 'ltr' },
  { code: 'pt', name: 'Portuguese (Brazilian)', nativeName: 'Português (Brasil)', flag: '🇧🇷', dir: 'ltr' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', flag: '🇸🇦', dir: 'rtl' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', flag: '🇮🇳', dir: 'ltr' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', flag: '🇷🇺', dir: 'ltr' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', flag: '🇯🇵', dir: 'ltr' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', flag: '🇹🇷', dir: 'ltr' },
]

export const messages: Record<LocaleCode, Messages> = {
  en,
  fa,
  es,
  fr,
  de,
  zh,
  pt,
  ar,
  hi,
  ru,
  ja,
  tr,
}

export const DEFAULT_LOCALE: LocaleCode = 'en'
export const LOCALE_STORAGE_KEY = 'aw-locale'

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === 'string' && (LOCALE_CODES as readonly string[]).includes(value)
}
