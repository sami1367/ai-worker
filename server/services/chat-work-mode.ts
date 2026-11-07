import { and, eq } from 'drizzle-orm'
import { chatWorkStates } from '#db/schema'
import { getDb } from '#utils/db'
import type { ChatScope } from '#shared/chat-work'

export async function chatWorkConversationInstructions(scope: ChatScope, sessionId: string, userId: string) {
  const [state] = await getDb().select({ mode: chatWorkStates.mode }).from(chatWorkStates).where(and(
    scope === 'project' ? eq(chatWorkStates.projectSessionId, sessionId) : eq(chatWorkStates.microserviceSessionId, sessionId),
    eq(chatWorkStates.createdByUserId, userId),
  )).limit(1)
  return state?.mode === 'work'
    ? 'This conversation is in Work mode. Help refine the implementation scope. The user can press Generate tasks to create or replace a local plan, then Approve & start work to queue implementation. Do not create forge issues or claim to execute work from a chat reply.'
    : 'This is Chat mode: discussion only. Do not implement changes, create issues, or steer the conversation into task generation. The user can explicitly switch to Work mode when they want implementation.'
}
