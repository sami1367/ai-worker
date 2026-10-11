import { fileURLToPath } from 'node:url'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  future: {
    compatibilityVersion: 4,
  },
  devtools: { enabled: process.env.NODE_ENV !== 'production' },

  modules: ['@nuxt/ui', '@nuxt/eslint'],

  css: ['~/assets/css/main.css'],

  colorMode: {
    preference: 'system',
    fallback: 'light',
    classSuffix: '',
  },

  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL || '',
    sessionSecret: process.env.NUXT_SESSION_PASSWORD || process.env.SESSION_SECRET || '',
    secretEncryptionKey: process.env.SECRET_ENCRYPTION_KEY || '',
    initialAdminUsername: process.env.INITIAL_ADMIN_USERNAME || '',
    initialAdminBootstrapSecret: process.env.INITIAL_ADMIN_BOOTSTRAP_SECRET || '',
    workerBaseDir: process.env.AI_WORKER_BASE_DIR || '',
    workspaceRoot: process.env.WORKSPACE_ROOT || '/data/workspaces',
    logsDir: process.env.LOGS_DIR || '',
    stateDir: process.env.STATE_DIR || '',
    configDir: process.env.CONFIG_DIR || '',
    githubToken: process.env.GITHUB_TOKEN || '',
    gitlabHost: process.env.GITLAB_HOST || '',
    gitlabToken: process.env.GITLAB_TOKEN || '',
    githubOauthClientId: process.env.GITHUB_OAUTH_CLIENT_ID || '',
    githubOauthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || '',
    gitlabOauthClientId: process.env.GITLAB_OAUTH_CLIENT_ID || '',
    gitlabOauthClientSecret: process.env.GITLAB_OAUTH_CLIENT_SECRET || '',
    gitlabTrustedHosts: process.env.GITLAB_TRUSTED_HOSTS || '',
    gitlabAllowHttp: process.env.GITLAB_ALLOW_HTTP || 'false',
    appVersion: process.env.APP_VERSION || '1.0.0',
    public: {
      appBaseUrl: process.env.APP_BASE_URL || 'http://127.0.0.1:8080',
      appName: 'AI Worker Platform',
    },
  },

  nitro: {
    experimental: {
      asyncContext: true,
    },
    alias: {
      '#services': fileURLToPath(new URL('./server/services', import.meta.url)),
      '#utils': fileURLToPath(new URL('./server/utils', import.meta.url)),
      '#db': fileURLToPath(new URL('./database', import.meta.url)),
    },
  },

  typescript: {
    strict: true,
    typeCheck: false,
  },

  app: {
    head: {
      title: 'AI Worker Platform',
      meta: [
        { name: 'description', content: 'Self-hosted management platform for AI-powered GitHub and GitLab automation' },
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,500;8..60,700&display=swap' },
      ],
    },
  },
})
