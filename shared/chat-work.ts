import { z } from 'zod'
export const chatScopeSchema = z.enum(['project', 'microservice'])
export type ChatScope = z.infer<typeof chatScopeSchema>
export const workTaskSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(12_000),
  repositoryIds: z.array(z.string().uuid()).min(1).max(20),
})
export type ChatWorkTask = z.infer<typeof workTaskSchema>
export type ChatWorkRepository = {
  id: string, name: string, directory: string, sourcePath: string, baseCommit: string,
  remoteUrl: string, fullName: string, forgeType: 'github' | 'gitlab', instanceUrl: string | null,
  connectionId: string, targetBranch: string, labels: string[], description: string,
}
export type ChatWorkResult = {
  repositoryId: string, name: string, branch: string, status: 'pending' | 'created' | 'no_changes' | 'failed',
  tree?: string, commit?: string,
  url?: string, error?: string,
}
export const ACTIVE_WORK_STATUSES = ['queued', 'preparing', 'running', 'publishing']
export type ChatWorkRunView = {
  id: string, title: string, chatUrl: string, planRevision: number, status: string, provider: string,
  tasks: ChatWorkTask[], results: ChatWorkResult[], errorSummary: string | null,
  repositories: Array<{ id: string, name: string, directory: string }>,
  startedAt: string | null, finishedAt: string | null, createdAt: string, canRetryPublish: boolean,
}
export type ChatWorkView = {
  mode: string, revision: number, tasks: ChatWorkTask[], generatedAt: string | null, stale: boolean,
  repositories: Array<{ id: string, name: string }>, runs: ChatWorkRunView[],
}
