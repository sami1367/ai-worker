import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname),
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, '.'),
      '~~': resolve(__dirname, '.'),
      '#db/schema': resolve(__dirname, 'database/schema/index.ts'),
      '#db': resolve(__dirname, 'database'),
      '#utils': resolve(__dirname, 'server/utils'),
      '#services': resolve(__dirname, 'server/services'),
    },
  },
})
