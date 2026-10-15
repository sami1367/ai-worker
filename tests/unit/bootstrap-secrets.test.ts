import { describe, expect, it } from 'vitest'
import { bootstrapAdmin } from '../../server/services/auth'
import { AppError } from '../../server/utils/errors'

describe('bootstrapAdmin secret policy', () => {
  it('rejects missing or insecure expected bootstrap secrets before touching the database', async () => {
    await expect(bootstrapAdmin({
      username: 'admin',
      email: 'admin@example.com',
      password: 'a-sufficiently-long-password',
      bootstrapSecret: 'changeme',
      expectedSecret: 'changeme',
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'bootstrap_misconfigured',
    } satisfies Partial<AppError>)

    await expect(bootstrapAdmin({
      username: 'admin',
      email: 'admin@example.com',
      password: 'a-sufficiently-long-password',
      bootstrapSecret: 'anything',
      expectedSecret: '',
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'bootstrap_misconfigured',
    })
  })
})
