/**
 * Public contact and project links for the About page and footer.
 * Update values here only — do not scatter URLs through unrelated UI logic.
 *
 * Use an empty string for optional channels that are not yet published;
 * the UI will show a clear placeholder instead of a broken link.
 */
export type SiteLink = {
  /** Stable key for i18n / tests */
  id: string
  label: string
  /** Absolute URL, mailto:, or empty when not configured */
  href: string
  /** Shown when href is empty */
  placeholder?: string
  optional?: boolean
}

export const SITE = {
  name: 'AI Worker',
  copyrightHolder: 'Sami Rahimi',
  copyrightYear: 2026,
  repositoryUrl: 'https://github.com/sami1367/ai-worker',
  licenseUrl: 'https://github.com/sami1367/ai-worker/blob/main/LICENSE',
  licenseSpdx: 'Apache-2.0',
  licenseName: 'Apache License 2.0',
  licenseSummary:
    'You may use, reproduce, and distribute this software under the terms of the Apache License 2.0, including the requirement to retain copyright and license notices. See the LICENSE file for the full terms.',
} as const

/** Primary contact channels shown on the About page */
export const CONTACT_LINKS: SiteLink[] = [
  {
    id: 'github',
    label: 'GitHub repository',
    href: SITE.repositoryUrl,
  },
  {
    id: 'email',
    label: 'Business email',
    href: 'mailto:sjd.rhm@gmail.com',
  },
  {
    id: 'website',
    label: 'Website',
    href: 'https://vibeplus1.com/',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    href: 'https://www.linkedin.com/in/sami-rahimi/',
  },
]

/** Optional collaboration links */
export const COLLABORATION_LINKS: SiteLink[] = [
  {
    id: 'issues',
    label: 'Report an issue',
    href: 'https://github.com/sami1367/ai-worker/issues',
    optional: true,
  },
  {
    id: 'contribute',
    label: 'Contribute',
    href: 'https://github.com/sami1367/ai-worker',
    optional: true,
  },
  {
    id: 'commercial',
    label: 'Request commercial services',
    href: 'mailto:sjd.rhm@gmail.com?subject=AI%20Worker%20commercial%20services',
    optional: true,
  },
]

export function linkIsConfigured(link: SiteLink): boolean {
  return Boolean(link.href?.trim())
}

export function displayHref(link: SiteLink): string {
  if (linkIsConfigured(link)) return link.href
  return link.placeholder || 'Not configured yet — update app/utils/site-links.ts'
}
