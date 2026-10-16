import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('setup page', () => {
  it('orders the bootstrap secret before username, email, and both password fields', () => {
    const source = readFileSync(resolve(__dirname, '../../app/pages/setup.vue'), 'utf8')
    const form = source.match(/<form\b[^>]*>([\s\S]*?)<\/form>/)?.[1] || ''
    const fields = [...form.matchAll(/<UFormField\b([\s\S]*?)>([\s\S]*?)<\/UFormField>/g)]

    expect(fields.map((field) => field[1].match(/label="([^"]+)"/)?.[1])).toEqual([
      'Bootstrap secret',
      'Admin username',
      'Admin email',
      'Password (min 12)',
      'Confirm password',
    ])
    expect(fields.map((field) => field[2].match(/v-model="([^"]+)"/)?.[1])).toEqual([
      'bootstrapSecret',
      'username',
      'email',
      'password',
      'confirm',
    ])
  })
})
