import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import {
  ensurePlatformSshKey,
  getPlatformSshPublicKeyInfo,
  platformSshPrivateKeyPath,
  platformSshPublicKeyPath,
} from '../../server/services/platform-ssh'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function tempBase() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-worker-ssh-'))
  temps.push(dir)
  return dir
}

describe('ensurePlatformSshKey', () => {
  it('generates a keypair once and keeps the same public key', async () => {
    const base = await tempBase()
    const first = await ensurePlatformSshKey({ baseDir: base, comment: 'test-key' })
    expect(first.created).toBe(true)

    const pub1 = (await readFile(platformSshPublicKeyPath(base), 'utf8')).trim()
    expect(pub1.startsWith('ssh-ed25519 ')).toBe(true)
    expect(pub1).toContain('test-key')

    const second = await ensurePlatformSshKey({ baseDir: base })
    expect(second.created).toBe(false)
    const pub2 = (await readFile(platformSshPublicKeyPath(base), 'utf8')).trim()
    expect(pub2).toBe(pub1)

    const priv = await readFile(platformSshPrivateKeyPath(base), 'utf8')
    expect(priv).toContain('PRIVATE KEY')
  })

  it('exposes public key info without private material', async () => {
    const base = await tempBase()
    await ensurePlatformSshKey({ baseDir: base, comment: 'info-key' })
    const info = await getPlatformSshPublicKeyInfo({ baseDir: base })

    expect(info.publicKey.startsWith('ssh-ed25519 ')).toBe(true)
    expect(info.privateKeyPresent).toBe(true)
    expect(JSON.stringify(info)).not.toContain('PRIVATE KEY')
    expect(info.fingerprint.startsWith('SHA256:')).toBe(true)
  })
})
