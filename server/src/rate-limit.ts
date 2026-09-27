import type { IncomingMessage } from 'node:http'

export class RateLimitError extends Error {
  readonly status = 429

  constructor(public readonly retryAfterSeconds: number) {
    super('Too many requests. Try again shortly.')
    this.name = 'RateLimitError'
  }
}

type Bucket = {
  startedAt: number
  count: number
}

const buckets = new Map<string, Bucket>()

function cleanupExpired(now: number, windowMs: number) {
  if (buckets.size < 5_000) return
  for (const [key, bucket] of buckets) {
    if (now - bucket.startedAt >= windowMs) buckets.delete(key)
  }
}

export function requestClientId(request: IncomingMessage) {
  const forwarded = request.headers['x-forwarded-for']
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded
  const hops = header?.split(',').map(hop => hop.trim()).filter(Boolean) ?? []
  return hops.at(-1) || request.socket.remoteAddress || 'unknown'
}

export function enforceRateLimit(input: {
  clientId: string
  scope: string
  limit: number
  windowSeconds: number
  identifier?: string
}) {
  const now = Date.now()
  const windowMs = input.windowSeconds * 1_000
  const key = `${input.clientId}:${input.scope}:${input.identifier || ''}`
  cleanupExpired(now, windowMs)
  const current = buckets.get(key)
  if (!current || now - current.startedAt >= windowMs) {
    buckets.set(key, { startedAt: now, count: 1 })
    return
  }

  if (current.count >= input.limit) {
    const elapsed = Math.max(0, now - current.startedAt)
    const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - elapsed) / 1_000))
    throw new RateLimitError(retryAfterSeconds)
  }
  current.count += 1
}

export function clearRateLimitBuckets() {
  buckets.clear()
}
