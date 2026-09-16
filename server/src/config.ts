import { defineChain, formatUnits, getAddress, isAddress, type Address, type Hex } from 'viem'

export const POLYGON_USDT_ADDRESS = getAddress('0xc2132D05D31c914a87C6611C10748AEb04B58e8F')
export const POLYGON_CHAIN_ID = 137

export const USDT_DECIMALS = 6
export const USDT_UINT256_MAX = (1n << 256n) - 1n

const polygonRpcUrl = process.env.POLYGON_RPC_URL?.trim()
const relayerPrivateKey = process.env.POLYGON_RELAYER_PRIVATE_KEY?.trim()
const nimRecipient = process.env.NIMFUEL_NIM_RECIPIENT?.trim() || null
const nimPaymentAmountLunaRaw = process.env.NIMFUEL_TEST_PAYMENT_LUNA?.trim() || null
const databaseUrl = process.env.DATABASE_URL?.trim()
const relayMaxAttemptsRaw = process.env.NIMFUEL_RELAY_MAX_ATTEMPTS?.trim() || '3'
const relayReservationGraceRaw = process.env.NIMFUEL_RELAY_RESERVATION_GRACE_SECONDS?.trim() || '60'
const liveBroadcastTtlRaw = process.env.NIMFUEL_LIVE_BROADCAST_TTL_SECONDS?.trim() || null
const liveBroadcastEnabled = process.env.NIMFUEL_ENABLE_LIVE_BROADCAST?.trim().toLowerCase() === 'true'
const quoteTtlRaw = process.env.NIMFUEL_QUOTE_TTL_SECONDS?.trim() || '300'
const serviceFeeBpsRaw = process.env.NIMFUEL_SERVICE_FEE_BPS?.trim() || '0'
const minPaymentLunaRaw = process.env.NIMFUEL_MIN_PAYMENT_LUNA?.trim() || '1000'
const fixedServiceFeeLunaRaw = process.env.NIMFUEL_FIXED_SERVICE_FEE_LUNA?.trim() || '0'
const minUsdtAmountText = process.env.NIMFUEL_MIN_USDT_AMOUNT?.trim() || '0.000001'
const maxUsdtAmountText = process.env.NIMFUEL_MAX_USDT_AMOUNT?.trim() || null
const liveProofAmountText = process.env.NIMFUEL_LIVE_PROOF_AMOUNT_USDT?.trim() || null
const adminApiToken = process.env.ADMIN_API_TOKEN?.trim() || null
const priceFallbackApiUrl = process.env.PRICE_FALLBACK_API_URL?.trim() || null
const priceFallbackApiKey = process.env.PRICE_FALLBACK_API_KEY?.trim() || null
const priceMaxDeviationBpsRaw = process.env.PRICE_MAX_DEVIATION_BPS?.trim() || '1500'
const priceMaxAgeSecondsRaw = process.env.PRICE_MAX_AGE_SECONDS?.trim() || '120'
const alertMinRelayerPolText = process.env.NIMFUEL_ALERT_MIN_RELAYER_POL?.trim() || '0.1'
const alertMinNimText = process.env.NIMFUEL_ALERT_MIN_NIM?.trim() || '10'
const alertWebhookUrl = process.env.NIMFUEL_ALERT_WEBHOOK_URL?.trim() || null
const alertCooldownSecondsRaw = process.env.NIMFUEL_ALERT_COOLDOWN_SECONDS?.trim() || '900'
const monitorIntervalSecondsRaw = process.env.NIMFUEL_MONITOR_INTERVAL_SECONDS?.trim() || '60'
const healthCacheSecondsRaw = process.env.NIMFUEL_HEALTH_CACHE_SECONDS?.trim() || '15'
const recoveryScanIntervalSecondsRaw = process.env.NIMFUEL_RECOVERY_SCAN_INTERVAL_SECONDS?.trim() || '30'
const relayReceiptTimeoutSecondsRaw = process.env.NIMFUEL_RELAY_RECEIPT_TIMEOUT_SECONDS?.trim() || '30'
const autoRefundAfterSecondsRaw = process.env.NIMFUEL_AUTO_REFUND_AFTER_SECONDS?.trim() || null
const rateLimitWindowSecondsRaw = process.env.NIMFUEL_RATE_LIMIT_WINDOW_SECONDS?.trim() || '60'
const rateLimitRequestsRaw = process.env.NIMFUEL_RATE_LIMIT_REQUESTS_PER_WINDOW?.trim() || '120'
const rateLimitPrepareRaw = process.env.NIMFUEL_RATE_LIMIT_PREPARE_PER_WINDOW?.trim() || '30'
const rateLimitOrderRaw = process.env.NIMFUEL_RATE_LIMIT_ORDER_PER_WINDOW?.trim() || '10'
const rateLimitRelayRaw = process.env.NIMFUEL_RATE_LIMIT_RELAY_PER_WINDOW?.trim() || '20'
const historyLimitRaw = process.env.NIMFUEL_HISTORY_LIMIT?.trim() || '20'
const allowedOriginsRaw = process.env.NIMFUEL_ALLOWED_ORIGINS?.trim() || '*'
const relayMaxAttempts = Number(relayMaxAttemptsRaw)

function parseUsdtAmountConfig(value: string, label: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(`${label} must be a positive USDT amount with at most ${USDT_DECIMALS} decimal places.`)
  }
  const [whole, fraction = ''] = value.split('.')
  const amount = BigInt(whole) * 10n ** BigInt(USDT_DECIMALS)
    + BigInt(fraction.padEnd(USDT_DECIMALS, '0') || '0')
  if (amount <= 0n) throw new Error(`${label} must be greater than zero.`)
  if (amount > USDT_UINT256_MAX) throw new Error(`${label} must fit inside the USDT token amount range.`)
  return amount
}

function parseDecimalAmountConfig(value: string, decimals: number, label: string, allowZero = false) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a non-negative decimal amount with at most ${decimals} decimal places.`)
  }
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) {
    throw new Error(`${label} must have at most ${decimals} decimal places.`)
  }
  const amount = BigInt(whole) * 10n ** BigInt(decimals)
    + BigInt(fraction.padEnd(decimals, '0') || '0')
  if (!allowZero && amount <= 0n) throw new Error(`${label} must be greater than zero.`)
  return amount
}

function parsePositiveInteger(value: string, label: string) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return Number(value)
}

function parseNonNegativeInteger(value: string, label: string) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
  return Number(value)
}
const nimPaymentAmountLuna = nimPaymentAmountLunaRaw && /^\d+$/.test(nimPaymentAmountLunaRaw) && BigInt(nimPaymentAmountLunaRaw) > 0n
  ? BigInt(nimPaymentAmountLunaRaw)
  : null

const quoteTtlSeconds = /^\d+$/.test(quoteTtlRaw) && Number(quoteTtlRaw) > 0 ? Number(quoteTtlRaw) : null
const serviceFeeBps = /^\d+$/.test(serviceFeeBpsRaw) && Number(serviceFeeBpsRaw) >= 0 && Number(serviceFeeBpsRaw) <= 10_000
  ? Number(serviceFeeBpsRaw)
  : null
const minPaymentLuna = /^\d+$/.test(minPaymentLunaRaw) && BigInt(minPaymentLunaRaw) > 0n
  ? BigInt(minPaymentLunaRaw)
  : null
const fixedServiceFeeLuna = /^\d+$/.test(fixedServiceFeeLunaRaw) && BigInt(fixedServiceFeeLunaRaw) >= 0n
  ? BigInt(fixedServiceFeeLunaRaw)
  : null
const minUsdtAmountRaw = parseUsdtAmountConfig(minUsdtAmountText, 'NIMFUEL_MIN_USDT_AMOUNT')
const maxUsdtAmountRaw = maxUsdtAmountText === null ? null : parseUsdtAmountConfig(maxUsdtAmountText, 'NIMFUEL_MAX_USDT_AMOUNT')
const liveProofAmountRaw = liveProofAmountText === null ? null : parseUsdtAmountConfig(liveProofAmountText, 'NIMFUEL_LIVE_PROOF_AMOUNT_USDT')
const priceMaxDeviationBps = parseNonNegativeInteger(priceMaxDeviationBpsRaw, 'PRICE_MAX_DEVIATION_BPS')
const priceMaxAgeSeconds = parsePositiveInteger(priceMaxAgeSecondsRaw, 'PRICE_MAX_AGE_SECONDS')
const alertMinRelayerPolRaw = parseDecimalAmountConfig(alertMinRelayerPolText, 18, 'NIMFUEL_ALERT_MIN_RELAYER_POL', true)
const alertMinNimLuna = parseDecimalAmountConfig(alertMinNimText, 5, 'NIMFUEL_ALERT_MIN_NIM', true)
const alertCooldownSeconds = parsePositiveInteger(alertCooldownSecondsRaw, 'NIMFUEL_ALERT_COOLDOWN_SECONDS')
const monitorIntervalSeconds = parsePositiveInteger(monitorIntervalSecondsRaw, 'NIMFUEL_MONITOR_INTERVAL_SECONDS')
const healthCacheSeconds = parsePositiveInteger(healthCacheSecondsRaw, 'NIMFUEL_HEALTH_CACHE_SECONDS')
const recoveryScanIntervalSeconds = parsePositiveInteger(recoveryScanIntervalSecondsRaw, 'NIMFUEL_RECOVERY_SCAN_INTERVAL_SECONDS')
const relayReceiptTimeoutSeconds = parsePositiveInteger(relayReceiptTimeoutSecondsRaw, 'NIMFUEL_RELAY_RECEIPT_TIMEOUT_SECONDS')
const autoRefundAfterSeconds = autoRefundAfterSecondsRaw === null
  ? null
  : parsePositiveInteger(autoRefundAfterSecondsRaw, 'NIMFUEL_AUTO_REFUND_AFTER_SECONDS')
const rateLimitWindowSeconds = parsePositiveInteger(rateLimitWindowSecondsRaw, 'NIMFUEL_RATE_LIMIT_WINDOW_SECONDS')
const rateLimitRequestsPerWindow = parsePositiveInteger(rateLimitRequestsRaw, 'NIMFUEL_RATE_LIMIT_REQUESTS_PER_WINDOW')
const rateLimitPreparePerWindow = parsePositiveInteger(rateLimitPrepareRaw, 'NIMFUEL_RATE_LIMIT_PREPARE_PER_WINDOW')
const rateLimitOrderPerWindow = parsePositiveInteger(rateLimitOrderRaw, 'NIMFUEL_RATE_LIMIT_ORDER_PER_WINDOW')
const rateLimitRelayPerWindow = parsePositiveInteger(rateLimitRelayRaw, 'NIMFUEL_RATE_LIMIT_RELAY_PER_WINDOW')
const historyLimit = parsePositiveInteger(historyLimitRaw, 'NIMFUEL_HISTORY_LIMIT')
const allowedOrigins = allowedOriginsRaw === '*'
  ? ['*']
  : allowedOriginsRaw.split(',').map(origin => origin.trim()).filter(Boolean)

if (allowedOrigins.length === 0) throw new Error('NIMFUEL_ALLOWED_ORIGINS must contain at least one origin or *.')

if (priceMaxDeviationBps > 10_000) throw new Error('PRICE_MAX_DEVIATION_BPS must be between 0 and 10000.')

if (!polygonRpcUrl) {
  throw new Error('POLYGON_RPC_URL is required.')
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for durable order storage.')
}

if (!/^\d+$/.test(relayMaxAttemptsRaw) || !Number.isSafeInteger(relayMaxAttempts) || relayMaxAttempts < 1) {
  throw new Error('NIMFUEL_RELAY_MAX_ATTEMPTS must be a positive integer.')
}

if (!/^\d+$/.test(relayReservationGraceRaw) || Number(relayReservationGraceRaw) < 1) {
  throw new Error('NIMFUEL_RELAY_RESERVATION_GRACE_SECONDS must be a positive integer.')
}

if (liveBroadcastTtlRaw !== null && (!/^\d+$/.test(liveBroadcastTtlRaw) || Number(liveBroadcastTtlRaw) < 1)) {
  throw new Error('NIMFUEL_LIVE_BROADCAST_TTL_SECONDS must be a positive integer when configured.')
}

if (quoteTtlSeconds === null) {
  throw new Error('NIMFUEL_QUOTE_TTL_SECONDS must be a positive integer.')
}

if (serviceFeeBps === null) {
  throw new Error('NIMFUEL_SERVICE_FEE_BPS must be an integer from 0 to 10000.')
}

if (minPaymentLuna === null) {
  throw new Error('NIMFUEL_MIN_PAYMENT_LUNA must be a positive integer.')
}

if (fixedServiceFeeLuna === null) {
  throw new Error('NIMFUEL_FIXED_SERVICE_FEE_LUNA must be a non-negative integer.')
}

if (maxUsdtAmountRaw !== null && maxUsdtAmountRaw < minUsdtAmountRaw) {
  throw new Error('NIMFUEL_MAX_USDT_AMOUNT must be greater than or equal to NIMFUEL_MIN_USDT_AMOUNT.')
}

if (liveProofAmountRaw !== null
  && (liveProofAmountRaw < minUsdtAmountRaw || (maxUsdtAmountRaw !== null && liveProofAmountRaw > maxUsdtAmountRaw))) {
  throw new Error('NIMFUEL_LIVE_PROOF_AMOUNT_USDT must be inside the configured USDT amount range.')
}

export const config = {
  host: process.env.HOST?.trim() || '0.0.0.0',
  port: Number(process.env.PORT?.trim() || 3001),
  polygonRpcUrl,
  databaseUrl,
  relayerPrivateKey: relayerPrivateKey && /^0x[0-9a-f]{64}$/i.test(relayerPrivateKey)
    ? relayerPrivateKey as Hex
    : null,
  nimRecipient,
  nimPaymentAmountLuna,
  nimVerificationEndpoint: process.env.NIMIQ_RPC_OR_VERIFICATION_ENDPOINT?.trim() || null,
  nimVerificationApiKeyConfigured: Boolean(process.env.NIMIQ_VERIFICATION_API_KEY?.trim()),
  priceApiUrl: process.env.PRICE_API_URL?.trim() || null,
  priceApiKey: process.env.PRICE_API_KEY?.trim() || null,
  priceFallbackApiUrl,
  priceFallbackApiKey,
  priceApiKeyConfigured: Boolean(process.env.PRICE_API_KEY?.trim()),
  priceFallbackApiKeyConfigured: Boolean(priceFallbackApiKey),
  priceNimTickerId: process.env.PRICE_NIM_TICKER_ID?.trim() || 'nim-nimiq',
  pricePolTickerId: process.env.PRICE_POL_TICKER_ID?.trim() || 'matic-polygon',
  priceMaxDeviationBps,
  priceMaxAgeSeconds,
  quoteTtlSeconds,
  serviceFeeBps,
  minPaymentLuna,
  fixedServiceFeeLuna,
  minUsdtAmountRaw,
  maxUsdtAmountRaw,
  liveProofAmountRaw,
  adminApiToken,
  refundSenderAddress: process.env.NIMFUEL_REFUND_SENDER_ADDRESS?.trim() || null,
  databaseConfigured: Boolean(process.env.DATABASE_URL?.trim()),
  liveBroadcastEnabled,
  liveBroadcastTtlSeconds: liveBroadcastTtlRaw === null ? null : Number(liveBroadcastTtlRaw),
  relayMaxAttempts,
  relayReservationGraceSeconds: Number(relayReservationGraceRaw),
  recoveryScanIntervalSeconds,
  relayReceiptTimeoutSeconds,
  autoRefundAfterSeconds,
  alertMinRelayerPolRaw,
  alertMinNimLuna,
  alertWebhookUrl,
  alertCooldownSeconds,
  monitorIntervalSeconds,
  healthCacheSeconds,
  rateLimitWindowSeconds,
  rateLimitRequestsPerWindow,
  rateLimitPreparePerWindow,
  rateLimitOrderPerWindow,
  rateLimitRelayPerWindow,
  historyLimit,
  allowedOrigins,
} as const

let liveBroadcastExpiresAt: number | null = null

export function armLiveBroadcastWindow() {
  liveBroadcastExpiresAt = config.liveBroadcastTtlSeconds === null
    ? null
    : Date.now() + config.liveBroadcastTtlSeconds * 1000
}

export function isLiveBroadcastEnabled() {
  return config.liveBroadcastEnabled
    && (liveBroadcastExpiresAt === null || Date.now() < liveBroadcastExpiresAt)
}

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('PORT must be a valid TCP port.')
}

export const polygon = defineChain({
  id: POLYGON_CHAIN_ID,
  name: 'Polygon',
  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  rpcUrls: { default: { http: [config.polygonRpcUrl] } },
  blockExplorers: { default: { name: 'PolygonScan', url: 'https://polygonscan.com' } },
})

export function formatUsdtAmount(value: bigint) {
  return formatUnits(value, USDT_DECIMALS)
}

export function validateUsdtAmount(amountRaw: bigint) {
  if (amountRaw <= 0n) throw new Error('USDT amount must be greater than zero.')
  if (amountRaw > USDT_UINT256_MAX) throw new Error('USDT amount is outside the token range.')
  if (amountRaw < config.minUsdtAmountRaw) {
    throw new Error(`USDT amount must be at least ${formatUsdtAmount(config.minUsdtAmountRaw)}.`)
  }
  if (config.maxUsdtAmountRaw !== null && amountRaw > config.maxUsdtAmountRaw) {
    throw new Error(`USDT amount must be at most ${formatUsdtAmount(config.maxUsdtAmountRaw)}.`)
  }
  return amountRaw
}

export function usdtAmountPolicy() {
  return {
    minUsdtAmount: formatUsdtAmount(config.minUsdtAmountRaw),
    maxUsdtAmount: config.maxUsdtAmountRaw === null ? null : formatUsdtAmount(config.maxUsdtAmountRaw),
    liveProofAmountUsdt: isLiveBroadcastEnabled() && config.liveProofAmountRaw !== null
      ? formatUsdtAmount(config.liveProofAmountRaw)
      : null,
  }
}

export function requireAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`${label} must be a valid EVM address.`)
  }
  return getAddress(value)
}

export function requireRawAmount(value: unknown, label = 'amountRaw'): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer string.`)
  }
  const amount = BigInt(value)
  if (amount <= 0n) throw new Error(`${label} must be greater than zero.`)
  return amount
}

export function requireUnsignedInteger(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer string.`)
  }
  return BigInt(value)
}
