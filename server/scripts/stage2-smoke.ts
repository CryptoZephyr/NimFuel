import { config } from '../src/config.js'
import { clearRateLimitBuckets, enforceRateLimit, RateLimitError } from '../src/rate-limit.js'
import { parseMarketPricePayload } from '../src/prices.js'

const apiBaseUrl = process.env.NIMFUEL_TEST_API_BASE_URL?.trim() || 'http://127.0.0.1:3001'
const probeAddress = '0x0000000000000000000000000000000000000001'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  let body: unknown = {}
  try {
    body = await response.json()
  } catch {
    body = {}
  }
  return { status: response.status, body }
}

async function main() {
  const parsed = parseMarketPricePayload({
    symbol: 'NIM',
    quotes: { USD: { price: '0.001234567891' } },
  }, 'nim-nimiq', 'smoke')
  assert(parsed.usdNanos === 1_234_568n, 'Price parsing did not round to USD nanos safely.')
  assert(parsed.provider === 'smoke' && !parsed.fromCache, 'Parsed price metadata was not retained.')
  console.log('price parsing and provider metadata: pass')

  clearRateLimitBuckets()
  enforceRateLimit({ clientId: 'stage2-smoke', scope: 'test', limit: 1, windowSeconds: 60 })
  let limited = false
  try {
    enforceRateLimit({ clientId: 'stage2-smoke', scope: 'test', limit: 1, windowSeconds: 60 })
  } catch (error) {
    limited = error instanceof RateLimitError && error.retryAfterSeconds >= 1
  }
  assert(limited, 'The in-memory rate-limit guard did not reject the second request.')
  console.log('rate-limit rejection and retry hint: pass')

  const health = await request('/health')
  assert(health.status === 200 && typeof health.body === 'object' && health.body !== null, 'The health endpoint did not respond with JSON.')
  const healthBody = health.body as Record<string, unknown>
  assert(['pass', 'degraded', 'fail'].includes(String(healthBody.status)), 'The health endpoint returned no status.')
  const checks = healthBody.checks
  assert(typeof checks === 'object' && checks !== null, 'The health endpoint returned no dependency checks.')
  for (const key of ['database', 'polygon', 'relayer', 'nim', 'pricing']) {
    assert(key in checks, `The health endpoint omitted the ${key} check.`)
  }
  console.log('dependency health snapshot: pass')

  const history = await request(`/v1/orders?evmAddress=${probeAddress}&limit=1`)
  assert(history.status === 200 && typeof history.body === 'object' && history.body !== null, 'The order history endpoint did not respond.')
  const historyBody = history.body as Record<string, unknown>
  assert(Array.isArray(historyBody.orders) && historyBody.limit === Math.min(1, config.historyLimit), 'The order history endpoint returned an invalid shape.')
  console.log('durable order history endpoint: pass')

  const adminMetrics = await request('/v1/admin/metrics')
  assert(adminMetrics.status === 401 || adminMetrics.status === 503, 'The admin metrics endpoint did not require configured admin access.')
  console.log('admin metrics authorization gate: pass')
}

await main()
console.log('stage 2 smoke: pass')
