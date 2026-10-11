import { createHash, randomBytes } from 'node:crypto'

export function newCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function newOAuthState(): string {
  return randomBytes(24).toString('base64url')
}
