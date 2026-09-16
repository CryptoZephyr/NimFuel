import { config } from './config.js'

export const USD_NANOS_PER_USD = 1_000_000_000n
export const LUNA_PER_NIM = 100_000n

export type MarketPrice = {
  tickerId: string
  symbol: string
  usd: string
  usdNanos: bigint
  retrievedAt: string
  provider: string
  fromCache: boolean
}

export type PriceProviderStatus = {
  provider: string
  tickerId: string
  status: 'pass' | 'fail'
  retrievedAt?: string
  error?: string
}

export type MarketPrices = {
  nim: MarketPrice
  pol: MarketPrice
  providers: PriceProviderStatus[]
  degraded: boolean
}

export type NimQuoteCalculation = {
  estimatedFeeUsdNanos: bigint
  serviceCostUsdNanos: bigint
  relayCostLuna: bigint
  serviceFeeLuna: bigint
  paymentAmountLuna: bigint
}

type PriceSource = {
  name: 'primary' | 'fallback'
  url: string
  apiKey: string | null
}

const priceCache = new Map<string, MarketPrice>()

function configuredSources() {
  const sources: PriceSource[] = []
  if (config.priceApiUrl) sources.push({ name: 'primary', url: config.priceApiUrl, apiKey: config.priceApiKey })
  if (config.priceFallbackApiUrl) sources.push({ name: 'fallback', url: config.priceFallbackApiUrl, apiKey: config.priceFallbackApiKey })
  return sources
}

function ceilDiv(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) throw new Error('Quote division requires a positive denominator.')
  return (numerator + denominator - 1n) / denominator
}

function parseUsdNanos(value: unknown) {
  const text = typeof value === 'number' && Number.isFinite(value)
    ? value.toString()
    : typeof value === 'string'
      ? value.trim()
      : ''

  if (!text || !/^\d+(\.\d+)?$/.test(text)) {
    throw new Error('Price API returned an invalid USD price.')
  }

  const [whole, fraction = ''] = text.split('.')
  const nanosText = `${fraction}000000000`
  const nanos = BigInt(nanosText.slice(0, 9))
  const rounded = nanosText[9] && Number(nanosText[9]) >= 5 ? nanos + 1n : nanos
  const result = BigInt(whole) * USD_NANOS_PER_USD + rounded
  if (result <= 0n) throw new Error('Price API returned a non-positive USD price.')
  return result
}

export function parseMarketPricePayload(payload: unknown, tickerId: string, provider: string, retrievedAt = new Date().toISOString()): MarketPrice {
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null
  const quotes = typeof record?.quotes === 'object' && record.quotes !== null
    ? record.quotes as Record<string, unknown>
    : null
  const usd = typeof quotes?.USD === 'object' && quotes.USD !== null
    ? quotes.USD as Record<string, unknown>
    : null
  const price = usd?.price
  const usdNanos = parseUsdNanos(price)

  return {
    tickerId,
    symbol: typeof record?.symbol === 'string' ? record.symbol : tickerId,
    usd: typeof price === 'number' || typeof price === 'string' ? String(price) : usdNanos.toString(),
    usdNanos,
    retrievedAt,
    provider,
    fromCache: false,
  }
}

async function fetchMarketPrice(source: PriceSource, tickerId: string) {
  const endpoint = `${source.url.replace(/\/$/, '')}/tickers/${encodeURIComponent(tickerId)}?quotes=USD`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (source.apiKey) headers['X-API-Key'] = source.apiKey

  let response: Response
  try {
    response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new Error(`Price API could not be reached for ${tickerId}.`)
  }

  if (!response.ok) throw new Error(`Price API returned HTTP ${response.status} for ${tickerId}.`)

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`Price API returned invalid JSON for ${tickerId}.`)
  }

  return parseMarketPricePayload(payload, tickerId, source.name)
}

function priceDeviationBps(first: bigint, second: bigint) {
  const larger = first > second ? first : second
  const smaller = first > second ? second : first
  if (larger === 0n) return 0
  return Number(((larger - smaller) * 10_000n) / larger)
}

function ageSeconds(retrievedAt: string) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(retrievedAt)) / 1000))
}

async function readTickerPrice(tickerId: string) {
  const sources = configuredSources()
  if (sources.length === 0) throw new Error('PRICE_API_URL is required for live NIM quotes.')

  const settled = await Promise.all(sources.map(async source => {
    try {
      return { source, price: await fetchMarketPrice(source, tickerId), error: null }
    } catch (error) {
      return { source, price: null, error: error instanceof Error ? error.message : 'Price source failed.' }
    }
  }))
  const successes = settled.filter((entry): entry is { source: PriceSource; price: MarketPrice; error: null } => entry.price !== null)

  if (successes.length === 0) {
    const cached = priceCache.get(tickerId)
    if (cached && ageSeconds(cached.retrievedAt) <= config.priceMaxAgeSeconds) {
      return {
        price: { ...cached, provider: `cache:${cached.provider}`, fromCache: true },
        statuses: settled.map(entry => ({
          provider: entry.source.name,
          tickerId,
          status: 'fail' as const,
          error: entry.error || 'Price source failed.',
        })),
        degraded: true,
      }
    }
    throw new Error(`No configured price source returned a usable ${tickerId} price.`)
  }

  if (successes.length > 1) {
    const primary = successes.find(entry => entry.source.name === 'primary')?.price || successes[0].price
    const disagreement = successes.some(entry => priceDeviationBps(primary.usdNanos, entry.price.usdNanos) > config.priceMaxDeviationBps)
    if (disagreement) {
      throw new Error(`Configured price sources disagree beyond the ${config.priceMaxDeviationBps} bps safety threshold for ${tickerId}.`)
    }
  }

  const selected = tickerId === config.pricePolTickerId
    ? successes.reduce((current, entry) => entry.price.usdNanos > current.usdNanos ? entry.price : current, successes[0].price)
    : successes.reduce((current, entry) => entry.price.usdNanos < current.usdNanos ? entry.price : current, successes[0].price)
  const provider = successes.length > 1
    ? `conservative:${successes.map(entry => entry.source.name).join(',')}`
    : successes[0].source.name
  const price = { ...selected, provider, fromCache: false }
  priceCache.set(tickerId, price)

  return {
    price,
    statuses: settled.map(entry => entry.price
      ? { provider: entry.source.name, tickerId, status: 'pass' as const, retrievedAt: entry.price.retrievedAt }
      : { provider: entry.source.name, tickerId, status: 'fail' as const, error: entry.error || 'Price source failed.' }),
    degraded: successes.length < sources.length,
  }
}

export async function readMarketPrices(): Promise<MarketPrices> {
  const [nim, pol] = await Promise.all([
    readTickerPrice(config.priceNimTickerId),
    readTickerPrice(config.pricePolTickerId),
  ])
  return {
    nim: nim.price,
    pol: pol.price,
    providers: [...nim.statuses, ...pol.statuses],
    degraded: nim.degraded || pol.degraded || nim.price.fromCache || pol.price.fromCache,
  }
}

export function clearPriceCache() {
  priceCache.clear()
}

export function calculateNimQuote(input: {
  estimatedFeeRaw: bigint
  polPriceUsdNanos: bigint
  nimPriceUsdNanos: bigint
  serviceFeeBps: number
  fixedServiceFeeLuna: bigint
  minPaymentLuna: bigint
}) {
  if (input.estimatedFeeRaw < 0n) throw new Error('Estimated relay fee cannot be negative.')
  if (input.polPriceUsdNanos <= 0n || input.nimPriceUsdNanos <= 0n) {
    throw new Error('NIM and POL prices must be positive.')
  }
  if (input.serviceFeeBps < 0 || input.serviceFeeBps > 10_000) {
    throw new Error('Service fee basis points are outside the supported range.')
  }

  const estimatedFeeUsdNanos = ceilDiv(
    input.estimatedFeeRaw * input.polPriceUsdNanos,
    10n ** 18n,
  )
  const serviceCostUsdNanos = ceilDiv(
    estimatedFeeUsdNanos * BigInt(10_000 + input.serviceFeeBps),
    10_000n,
  )
  const relayCostLuna = ceilDiv(
    serviceCostUsdNanos * LUNA_PER_NIM,
    input.nimPriceUsdNanos,
  )
  const paymentAmountLuna = [
    input.minPaymentLuna,
    relayCostLuna + input.fixedServiceFeeLuna,
  ].reduce((max, value) => value > max ? value : max, 0n)

  return {
    estimatedFeeUsdNanos,
    serviceCostUsdNanos,
    relayCostLuna,
    serviceFeeLuna: input.fixedServiceFeeLuna,
    paymentAmountLuna,
  } satisfies NimQuoteCalculation
}

export function formatUsdNanos(value: bigint) {
  const whole = value / USD_NANOS_PER_USD
  const fraction = value % USD_NANOS_PER_USD
  if (fraction === 0n) return whole.toString()
  return `${whole}.${fraction.toString().padStart(9, '0').replace(/0+$/, '')}`
}
