import { config } from './config.js'

export const USD_NANOS_PER_USD = 1_000_000_000n
export const LUNA_PER_NIM = 100_000n

export type MarketPrice = {
  tickerId: string
  symbol: string
  usd: string
  usdNanos: bigint
  retrievedAt: string
}

export type NimQuoteCalculation = {
  estimatedFeeUsdNanos: bigint
  serviceCostUsdNanos: bigint
  relayCostLuna: bigint
  serviceFeeLuna: bigint
  paymentAmountLuna: bigint
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
  const roundedFraction = `${fraction}000000000`.slice(0, 10)
  const nanos = BigInt(`${fraction.slice(0, 9)}000000000`.slice(0, 9))
  const rounded = roundedFraction[9] && Number(roundedFraction[9]) >= 5 ? nanos + 1n : nanos
  const result = BigInt(whole) * USD_NANOS_PER_USD + rounded
  if (result <= 0n) throw new Error('Price API returned a non-positive USD price.')
  return result
}

async function fetchMarketPrice(tickerId: string) {
  if (!config.priceApiUrl) throw new Error('PRICE_API_URL is required for live NIM quotes.')

  const endpoint = `${config.priceApiUrl.replace(/\/$/, '')}/tickers/${encodeURIComponent(tickerId)}?quotes=USD`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (process.env.PRICE_API_KEY?.trim()) headers['X-API-Key'] = process.env.PRICE_API_KEY.trim()

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
    retrievedAt: new Date().toISOString(),
  } satisfies MarketPrice
}

export async function readMarketPrices() {
  const [nim, pol] = await Promise.all([
    fetchMarketPrice(config.priceNimTickerId),
    fetchMarketPrice(config.pricePolTickerId),
  ])
  return { nim, pol }
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
