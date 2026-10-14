/**
 * Lightweight i18n scaffold — English default.
 * Persian-ready message map can be expanded without changing call sites.
 */
export default defineNuxtPlugin(() => {
  const locale = useState<'en' | 'fa'>('locale', () => 'en')
  const messages: Record<string, Record<string, string>> = {
    en: {
      'nav.dashboard': 'Dashboard',
      'nav.connections': 'Connections',
      'nav.repositories': 'Repositories',
      'nav.tasks': 'Tasks',
      'nav.providers': 'Providers',
      'nav.prompts': 'Prompts',
      'nav.settings': 'Settings',
      'nav.system': 'System',
      'nav.audit': 'Audit',
      'nav.about': 'About',
      'nav.logout': 'Logout',
      'about.title': 'About AI Worker',
      'about.subtitle': 'Product overview, services, contact, and license',
      'about.product.heading': 'About AI Worker',
      'about.services.heading': 'Services',
      'about.contact.heading': 'Contact and collaboration',
      'about.license.heading': 'License',
      'footer.about': 'About',
      'footer.repository': 'Repository',
      'footer.license': 'License',
      'footer.contact': 'Contact',
    },
    fa: {
      'nav.dashboard': 'داشبورد',
      'nav.connections': 'اتصالات',
      'nav.repositories': 'مخازن',
      'nav.tasks': 'وظایف',
      'nav.providers': 'ارائه‌دهندگان',
      'nav.prompts': 'پرامپت‌ها',
      'nav.settings': 'تنظیمات',
      'nav.system': 'سیستم',
      'nav.audit': 'ممیزی',
      'nav.about': 'درباره',
      'nav.logout': 'خروج',
      'about.title': 'درباره AI Worker',
      'about.subtitle': 'معرفی محصول، خدمات، تماس و مجوز',
      'about.product.heading': 'درباره AI Worker',
      'about.services.heading': 'خدمات',
      'about.contact.heading': 'تماس و همکاری',
      'about.license.heading': 'مجوز',
      'footer.about': 'درباره',
      'footer.repository': 'مخزن',
      'footer.license': 'مجوز',
      'footer.contact': 'تماس',
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
