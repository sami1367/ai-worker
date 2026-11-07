import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { deleteChatConversation } from '../../server/services/chat-conversations'
const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], deleted: [] as unknown[], locks: [] as string[], transactions: 0 }))
vi.mock('#utils/db', () => ({ getDb: () => ({ transaction: async (callback: (tx: unknown) => unknown) => {
  mocks.transactions++
  return callback({
    select: () => ({ from: () => {
      const query = {
        where: () => query,
        for: (lock: string) => { mocks.locks.push(lock); return query },
        limit: async () => mocks.rows.shift() || [],
      }
      return query
    } }),
    delete: () => ({ where: async (condition: unknown) => { mocks.deleted.push(condition) } }),
  })
} }) }))
const id = '11111111-1111-4111-8111-111111111111'
const groupId = '22222222-2222-4222-8222-222222222222'
beforeEach(() => { mocks.rows = []; mocks.deleted = []; mocks.locks = []; mocks.transactions = 0 })
const params = (condition: unknown) => new PgDialect().sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]).params

describe('conversation deletion', () => {
  it('deletes only the owned project conversation', async () => {
    mocks.rows = [[{ id }], []]
    await expect(deleteChatConversation('project', id, 'owner')).resolves.toEqual({ ok: true })
    expect(params(mocks.deleted[0])).toEqual([id, 'owner'])
  })
  it('scopes microservice deletion to the selected group and the owner', async () => {
    mocks.rows = [[{ id }], []]
    await deleteChatConversation('microservice', id, 'owner', groupId)
    expect(params(mocks.deleted[0])).toEqual([id, 'owner', groupId])
  })
  it('does not delete a foreign conversation or one outside the selected group', async () => {
    mocks.rows = [[]]
    await expect(deleteChatConversation('microservice', id, 'stranger', groupId)).rejects.toThrow('Conversation not found')
    expect(mocks.deleted).toHaveLength(0)
  })
  it('protects conversations with queued or running background work', async () => {
    mocks.rows = [[{ id }], [{ id: 'state' }], [{ id: 'active-run' }]]
    await expect(deleteChatConversation('project', id, 'owner')).rejects.toThrow('ongoing work')
    expect(mocks.deleted).toHaveLength(0)
    expect(mocks.locks).toEqual(['update', 'update'])
  })
  it('allows deleting completed work history while locking against simultaneous approval', async () => {
    mocks.rows = [[{ id }], [{ id: 'state' }], []]
    await deleteChatConversation('project', id, 'owner')
    expect(mocks.transactions).toBe(1)
    expect(mocks.locks).toEqual(['update', 'update'])
    expect(mocks.deleted).toHaveLength(1)
  })
  it('rejects invalid conversation references before querying the database', async () => {
    await expect(deleteChatConversation('project', '../bad', 'owner')).rejects.toThrow('Invalid conversation')
    await expect(deleteChatConversation('microservice', id, 'owner')).rejects.toThrow('Invalid conversation')
    expect(mocks.transactions).toBe(0)
  })
})
