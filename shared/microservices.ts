import { z } from 'zod'

export const SERVICE_LABELS = ['frontend', 'backend', 'api', 'gateway', 'admin', 'worker', 'shared-library', 'database', 'infrastructure', 'authentication', 'messaging', 'payments', 'notifications', 'mobile', 'integration']
export const microserviceGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).default(''),
  codegraphEnabled: z.boolean().default(true),
  projects: z.array(z.object({
    repositoryId: z.string().uuid(),
    labels: z.array(z.string().trim().min(1).max(40)).max(15).default([]),
    description: z.string().trim().max(1000).default(''),
  })).min(2, 'Select at least two projects').max(20)
    .refine(projects => new Set(projects.map(project => project.repositoryId)).size === projects.length, 'Select each project only once'),
})
export type MicroserviceGroupInput = z.infer<typeof microserviceGroupSchema>
export type MicroserviceProject = MicroserviceGroupInput['projects'][number] & { directory: string }
