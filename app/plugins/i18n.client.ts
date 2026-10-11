/**
 * Lightweight i18n scaffold — English default.
 * Persian-ready message map can be expanded without changing call sites.
 */
export default defineNuxtPlugin(() => {
  const locale = useState<'en' | 'fa'>('locale', () => 'en')
  const messages: Record<string, Record<string, string>> = {
    en: {
      'nav.dashboard': 'Dashboard',
      'nav.repositories': 'Repositories',
      'nav.tasks': 'Tasks',
    },
    fa: {
      'nav.dashboard': 'داشبورد',
      'nav.repositories': 'مخازن',
      'nav.tasks': 'وظایف',
    },
  }

  function t(key: string) {
    return messages[locale.value]?.[key] || messages.en[key] || key
  }

  return {
    provide: {
      i18n: { locale, t },
    },
  }
})
