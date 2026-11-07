import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { chatWorkRuns, chatWorkStates, microserviceChatSessions, projectChatSessions } from '#db/schema'
import { getDb } from '#utils/db'
import { AppError } from '#utils/errors'
import { ACTIVE_WORK_STATUSES, type ChatScope } from '#shared/chat-work'

/** Permanently delete an owned chat; serialize with approval to protect background work. */
export async function deleteChatConversation(scope: ChatScope, id: string, userId: string, groupId?: string) {
  if (!z.string().uuid().safeParse(id).success || (scope === 'microservice' && !z.string().uuid().safeParse(groupId).success)) {
    throw new AppError(400, 'Invalid conversation reference', 'validation_error')
  }
  const table = scope === 'project' ? projectChatSessions : microserviceChatSessions
  const condition = and(eq(table.id, id), eq(table.createdByUserId, userId),
    ...(scope === 'microservice' ? [eq(microserviceChatSessions.groupId, groupId!)] : []))
  await getDb().transaction(async tx => {
    const [session] = await tx.select({ id: table.id }).from(table).where(condition).for('update').limit(1)
    if (!session) throw new AppError(404, 'Conversation not found', 'not_found')
    const [state] = await tx.select({ id: chatWorkStates.id }).from(chatWorkStates).where(and(
      eq(chatWorkStates.createdByUserId, userId),
      scope === 'project' ? eq(chatWorkStates.projectSessionId, id) : eq(chatWorkStates.microserviceSessionId, id),
    )).for('update').limit(1)
    if (state) {
      const [active] = await tx.select({ id: chatWorkRuns.id }).from(chatWorkRuns).where(and(
        eq(chatWorkRuns.stateId, state.id), inArray(chatWorkRuns.status, ACTIVE_WORK_STATUSES),
      )).limit(1)
      if (active) throw new AppError(409, 'This conversation has ongoing work. Wait for it to finish before deleting.', 'chat_work_active')
    }
    await tx.delete(table).where(condition)
  })
  return { ok: true }
}
