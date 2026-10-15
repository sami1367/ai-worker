import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { providerConfigs, settings } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { writeAudit } from './audit'

export const settingsSchema = z.object({
  pollIntervalSeconds: z.number().int().min(15).max(3600).default(30),
  maxGlobalConcurrentTasks: z.number().int().min(1).max(64).default(8),
  defaultAiProvider: z.enum(['cursor', 'claude', 'codex']).default('cursor'),
  defaultBlockOnOpenPr: z.boolean().default(true),
  logRetentionDays: z.number().int().min(1).max(365).default(30),
  timezone: z.string().min(1).max(64).default('UTC'),
  uiTheme: z.enum(['system', 'light', 'dark']).default('system'),
  configVersion: z.number().int().min(0).default(0),
})

export type AppSettings = z.infer<typeof settingsSchema>

const DEFAULTS: AppSettings = settingsSchema.parse({})

export async function getSettings(): Promise<AppSettings> {
  const db = getDb()
  const rows = await db.select().from(settings)
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, unknown>
  return settingsSchema.parse({ ...DEFAULTS, ...map })
}

export async function updateSettings(
  patch: Partial<AppSettings>,
  actor: { id: string, username: string },
  ipHash?: string,
): Promise<AppSettings> {
  const current = await getSettings()
  const merged = settingsSchema.parse({ ...current, ...patch, configVersion: current.configVersion })
  // Increment config version when operational settings change
  const bumpKeys: (keyof AppSettings)[] = [
    'pollIntervalSeconds',
    'maxGlobalConcurrentTasks',
    'defaultAiProvider',
    'defaultBlockOnOpenPr',
    'logRetentionDays',
    'timezone',
  ]
  const shouldBump = bumpKeys.some((k) => patch[k] !== undefined && patch[k] !== current[k])
  if (shouldBump) {
    merged.configVersion = current.configVersion + 1
  }

  const db = getDb()
  for (const [key, value] of Object.entries(merged)) {
    await db
      .insert(settings)
      .values({
        key,
        value,
        updatedAt: new Date(),
        updatedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value,
          updatedAt: new Date(),
          updatedBy: actor.id,
        },
      })
  }

  // Keep provider_configs.isDefault in sync when Settings changes the default agent.
  if (patch.defaultAiProvider && patch.defaultAiProvider !== current.defaultAiProvider) {
    await db.update(providerConfigs).set({ isDefault: false })
    await db.update(providerConfigs).set({
      isDefault: true,
      updatedAt: new Date(),
    }).where(eq(providerConfigs.providerType, patch.defaultAiProvider))
  }

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'settings.update',
    targetType: 'settings',
    metadata: { keys: Object.keys(patch), configVersion: merged.configVersion },
    ipHash,
  })

  if (shouldBump) {
    try {
      const { applyWorkerRuntimeChange } = await import('./worker-runtime')
      await applyWorkerRuntimeChange('settings.update', {
        keys: Object.keys(patch),
        configVersion: merged.configVersion,
      })
    } catch {
      // ignore during early boot / tests
    }
  }

  return merged
}

export async function bumpConfigVersion(_actor?: { id?: string | null, username: string }) {
  const current = await getSettings()
  const next = current.configVersion + 1
  const db = getDb()
  await db.insert(settings).values({
    key: 'configVersion',
    value: next,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: settings.key,
    set: { value: next, updatedAt: new Date() },
  })
  const updated = { ...current, configVersion: next }
  // Best-effort: keep worker-runtime.env CONFIG_VERSION current for heartbeats.
  try {
    const { exportWorkerRuntimeEnv } = await import('./worker-runtime')
    await exportWorkerRuntimeEnv()
  } catch {
    // ignore during early boot / tests
  }
  return updated
}

export function assertSettingRanges(patch: unknown): Partial<AppSettings> {
  const parsed = settingsSchema.partial().safeParse(patch)
  if (!parsed.success) {
    throw new AppError(400, 'Invalid settings', 'validation_error', parsed.error.flatten())
  }
  return parsed.data
}
