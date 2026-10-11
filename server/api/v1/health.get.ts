export default defineEventHandler(async () => {
  return {
    status: 'ok',
    service: 'ai-worker-platform',
    version: useRuntimeConfig().appVersion || process.env.APP_VERSION || '1.0.0',
    time: new Date().toISOString(),
  }
})
