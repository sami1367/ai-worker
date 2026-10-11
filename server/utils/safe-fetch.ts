import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { AppError } from './errors'

export interface SafeUrlOptions {
  /** When true, allow http:// for explicitly allowlisted hosts only. */
  allowHttp?: boolean
  /** Explicit host allowlist for private/internal GitLab instances (hostnames only). */
  trustedHosts?: string[]
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'metadata.aws.internal',
])

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
}

function isPrivateOrReservedIp(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
      return true
    }
    // IPv4-mapped IPv6
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.slice('::ffff:'.length)
      if (isIP(v4) === 4) return isPrivateOrReservedIp(v4)
    }
    return false
  }

  const n = ipv4ToInt(ip)
  const ranges: Array<[number, number]> = [
    [ipv4ToInt('0.0.0.0'), ipv4ToInt('0.255.255.255')],
    [ipv4ToInt('10.0.0.0'), ipv4ToInt('10.255.255.255')],
    [ipv4ToInt('127.0.0.0'), ipv4ToInt('127.255.255.255')],
    [ipv4ToInt('169.254.0.0'), ipv4ToInt('169.254.255.255')],
    [ipv4ToInt('172.16.0.0'), ipv4ToInt('172.31.255.255')],
    [ipv4ToInt('192.168.0.0'), ipv4ToInt('192.168.255.255')],
    [ipv4ToInt('100.64.0.0'), ipv4ToInt('100.127.255.255')],
    [ipv4ToInt('198.18.0.0'), ipv4ToInt('198.19.255.255')],
  ]
  return ranges.some(([start, end]) => n >= start && n <= end)
}

export function normalizeInstanceUrl(raw: string, opts: SafeUrlOptions = {}): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) throw new AppError(400, 'Server URL is required', 'invalid_url')

  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    throw new AppError(400, 'Invalid server URL', 'invalid_url')
  }

  if (url.username || url.password) {
    throw new AppError(400, 'Credentials in server URL are not allowed', 'invalid_url')
  }
  if (url.hash || url.search) {
    throw new AppError(400, 'Query or fragment in server URL is not allowed', 'invalid_url')
  }
  if (url.pathname && url.pathname !== '/') {
    throw new AppError(400, 'Server URL must not include a path', 'invalid_url')
  }

  const trusted = new Set((opts.trustedHosts || trustedHostsFromEnv()).map((h) => h.toLowerCase()))
  const host = url.hostname.toLowerCase()

  if (url.protocol === 'http:') {
    const allowHttp = opts.allowHttp ?? process.env.GITLAB_ALLOW_HTTP === 'true'
    if (!allowHttp || !trusted.has(host)) {
      throw new AppError(400, 'HTTPS is required for GitLab server URLs', 'invalid_url')
    }
  } else if (url.protocol !== 'https:') {
    throw new AppError(400, 'Only https URLs are supported', 'invalid_url')
  }

  if (BLOCKED_HOSTNAMES.has(host) && !trusted.has(host)) {
    throw new AppError(400, 'Server host is not allowed', 'ssrf_blocked')
  }

  if (isIP(host) && isPrivateOrReservedIp(host) && !trusted.has(host)) {
    throw new AppError(400, 'Private or reserved IP addresses are not allowed', 'ssrf_blocked')
  }

  return `${url.protocol}//${url.host}`
}

export function trustedHostsFromEnv(): string[] {
  const raw = process.env.GITLAB_TRUSTED_HOSTS || ''
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
}

export async function assertSafeOutboundUrl(rawUrl: string, opts: SafeUrlOptions = {}): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AppError(400, 'Invalid outbound URL', 'invalid_url')
  }

  const trusted = new Set((opts.trustedHosts || trustedHostsFromEnv()).map((h) => h.toLowerCase()))
  const host = url.hostname.toLowerCase()

  if (url.protocol === 'http:') {
    const allowHttp = opts.allowHttp ?? process.env.GITLAB_ALLOW_HTTP === 'true'
    if (!allowHttp || !trusted.has(host)) {
      throw new AppError(400, 'Refusing non-HTTPS outbound request', 'ssrf_blocked')
    }
  } else if (url.protocol !== 'https:') {
    throw new AppError(400, 'Unsupported URL scheme', 'ssrf_blocked')
  }

  if (BLOCKED_HOSTNAMES.has(host) && !trusted.has(host)) {
    throw new AppError(400, 'Outbound host is blocked', 'ssrf_blocked')
  }

  if (isIP(host)) {
    if (isPrivateOrReservedIp(host) && !trusted.has(host)) {
      throw new AppError(400, 'Outbound IP is blocked', 'ssrf_blocked')
    }
  } else {
    let records: string[]
    try {
      const looked = await lookup(host, { all: true, verbatim: true })
      records = looked.map((r) => r.address)
    } catch {
      throw new AppError(400, 'Unable to resolve server host', 'dns_failed')
    }
    for (const addr of records) {
      if (isPrivateOrReservedIp(addr) && !trusted.has(host)) {
        throw new AppError(400, 'Server resolves to a private or reserved address', 'ssrf_blocked')
      }
    }
  }

  return url
}

export async function safeFetch(
  rawUrl: string,
  init: RequestInit & { timeoutMs?: number; expectedOrigin?: string } = {},
  opts: SafeUrlOptions = {},
): Promise<Response> {
  const { timeoutMs = 30000, expectedOrigin, ...fetchInit } = init
  const url = await assertSafeOutboundUrl(rawUrl, opts)

  if (expectedOrigin) {
    const expected = new URL(expectedOrigin)
    if (url.origin !== expected.origin) {
      throw new AppError(400, 'Outbound URL escaped approved origin', 'ssrf_blocked')
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url.toString(), {
      ...fetchInit,
      redirect: 'manual',
      signal: controller.signal,
    })

    // Follow limited redirects only within the approved origin
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new AppError(502, 'Redirect without location', 'bad_gateway')
      const next = new URL(location, url)
      if (expectedOrigin && next.origin !== new URL(expectedOrigin).origin) {
        throw new AppError(400, 'Redirect escaped approved origin', 'ssrf_blocked')
      }
      await assertSafeOutboundUrl(next.toString(), opts)
      return safeFetch(next.toString(), { ...init, timeoutMs }, opts)
    }

    return response
  } finally {
    clearTimeout(timer)
  }
}
