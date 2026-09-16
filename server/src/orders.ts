import { randomUUID } from 'node:crypto'
import { formatUnits } from 'viem'
import { pool, withTransaction } from './db.js'
import type { PoolClient } from 'pg'
import { config, USDT_DECIMALS } from './config.js'
import { encodeNimReference, formatNimAddress } from './nim.js'
import { formatUsdNanos } from './prices.js'

export type OrderState =
  | 'AWAITING_NIM_PAYMENT'
  | 'NIM_PAYMENT_CONFIRMED'
  | 'PAYMENT_EXPIRED'
  | 'PAYMENT_MISMATCH'
  | 'RELAY_BROADCASTING'
  | 'RELAY_SUBMITTED'
  | 'RELAY_FAILED'
  | 'RECOVERY_REQUIRED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'FULFILLED'

export type RelayAttemptStatus =
  | 'BROADCASTING'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'RECOVERY_REQUIRED'

export type NimfuelOrder = {
  id: string
  reference: string
  expectedPaymentDataHex: string
  nimAddress: string
  paymentRecipient: string
  paymentAmountLuna: bigint
  evmAddress: string
  recipient: string
  amountRaw: bigint
  state: OrderState
  createdAt: number
  expiresAt: number
  updatedAt: number
  paymentTxHash?: string
  paymentBlockNumber?: number
  paymentConfirmations?: number
  paymentVerifiedAt?: number
  relayAuthorizationDigest?: string
  relayTxHash?: string
  relayBlockNumber?: number
  relaySubmittedAt?: number
  relayVerifiedAt?: number
  quoteId?: string
  quoteAuthorizationDigest?: string
  quoteGasEstimate?: bigint
  quoteGasPrice?: bigint
  quoteEstimatedFeeRaw?: bigint
  quotePolPriceUsdNanos?: bigint
  quoteNimPriceUsdNanos?: bigint
  quoteServiceFeeBps?: number
  quoteServiceFeeLuna?: bigint
  quotePaymentAmountLuna?: bigint
  quoteRelayCostLuna?: bigint
  quotePriceSource?: string
  quoteCreatedAt?: number
  quoteExpiresAt?: number
  refundRecipient?: string
  refundAmountLuna?: bigint
  refundRequestedAt?: number
  refundTxHash?: string
  refundBlockNumber?: number
  refundConfirmations?: number
  refundVerifiedAt?: number
  refundLastError?: string
  lastError?: string
}

export type RelayAuthorizationRecord = {
  orderId: string
  authorizationDigest: string
  nonce: bigint
  deadline: bigint
  userAddress: string
  recipient: string
  amountRaw: bigint
  decimals: number
  functionSignature: string
  signature: string
  executeData: string
  gasEstimate: bigint
  gasPrice: bigint
  estimatedFeeRaw: bigint
  relayerAddress: string
}

export type RelayAttempt = RelayAuthorizationRecord & {
  id: string
  status: RelayAttemptStatus
  txHash?: string
  receiptStatus?: string
  blockNumber?: number
  gasUsed?: bigint
  transferVerified?: boolean
  nonceAdvanced?: boolean
  createdAt: number
  submittedAt?: number
  confirmedAt?: number
  lastError?: string
}

export type RelayReservation = {
  created: boolean
  order: NimfuelOrder
  attempt: RelayAttempt
}

export type NimQuote = {
  id: string
  authorizationDigest: string
  userAddress: string
  recipient: string
  amountRaw: bigint
  nonce: bigint
  deadline: bigint
  decimals: number
  functionSignature: string
  signature: string
  executeData: string
  gasEstimate: bigint
  gasPrice: bigint
  estimatedFeeRaw: bigint
  relayerAddress: string
  polPriceUsdNanos: bigint
  nimPriceUsdNanos: bigint
  serviceFeeBps: number
  serviceFeeLuna: bigint
  relayCostLuna: bigint
  paymentAmountLuna: bigint
  priceSource: string
  createdAt: number
  expiresAt: number
  consumedAt?: number
  consumedOrderId?: string
}

export type RelayOutcome = {
  status: Extract<RelayAttemptStatus, 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'RECOVERY_REQUIRED'>
  receiptStatus?: string | null
  blockNumber?: bigint | null
  gasUsed?: bigint | null
  transferVerified?: boolean | null
  nonceAdvanced?: boolean | null
  error?: string | null
}

type DbTimestamp = Date | string
type DbNumeric = string | number | bigint

type DbOrderRow = {
  id: string
  reference: string
  expected_payment_data_hex: string
  nim_address: string
  payment_recipient: string
  payment_amount_luna: DbNumeric
  evm_address: string
  recipient: string
  amount_raw: DbNumeric
  state: string
  created_at: DbTimestamp
  expires_at: DbTimestamp
  payment_tx_hash: string | null
  payment_block_number: DbNumeric | null
  payment_confirmations: number | null
  payment_verified_at: DbTimestamp | null
  relay_authorization_digest: string | null
  relay_tx_hash: string | null
  relay_block_number: DbNumeric | null
  relay_submitted_at: DbTimestamp | null
  relay_verified_at: DbTimestamp | null
  quote_id: string | null
  quote_authorization_digest: string | null
  quote_gas_estimate: DbNumeric | null
  quote_gas_price: DbNumeric | null
  quote_estimated_fee_raw: DbNumeric | null
  quote_pol_price_usd_nanos: DbNumeric | null
  quote_nim_price_usd_nanos: DbNumeric | null
  quote_service_fee_bps: number | null
  quote_service_fee_luna: DbNumeric | null
  quote_payment_amount_luna: DbNumeric | null
  quote_relay_cost_luna: DbNumeric | null
  quote_price_source: string | null
  quote_created_at: DbTimestamp | null
  quote_expires_at: DbTimestamp | null
  refund_recipient: string | null
  refund_amount_luna: DbNumeric | null
  refund_requested_at: DbTimestamp | null
  refund_tx_hash: string | null
  refund_block_number: DbNumeric | null
  refund_confirmations: number | null
  refund_verified_at: DbTimestamp | null
  refund_last_error: string | null
  last_error: string | null
  updated_at: DbTimestamp
}

type DbRelayAttemptRow = {
  id: DbNumeric
  order_id: string
  authorization_digest: string
  nonce: DbNumeric
  deadline: DbNumeric
  user_address: string
  recipient: string
  amount_raw: DbNumeric
  decimals: number
  function_signature: string
  signature: string
  execute_data: string
  gas_estimate: DbNumeric
  gas_price: DbNumeric
  estimated_fee_raw: DbNumeric
  relayer_address: string
  status: string
  tx_hash: string | null
  receipt_status: string | null
  block_number: DbNumeric | null
  gas_used: DbNumeric | null
  transfer_verified: boolean | null
  nonce_advanced: boolean | null
  created_at: DbTimestamp
  submitted_at: DbTimestamp | null
  confirmed_at: DbTimestamp | null
  last_error: string | null
  updated_at: DbTimestamp
}

type DbQuoteRow = {
  id: string
  authorization_digest: string
  user_address: string
  recipient: string
  amount_raw: DbNumeric
  nonce: DbNumeric
  deadline: DbNumeric
  decimals: number
  function_signature: string
  signature: string
  execute_data: string
  gas_estimate: DbNumeric
  gas_price: DbNumeric
  estimated_fee_raw: DbNumeric
  relayer_address: string
  pol_price_usd_nanos: DbNumeric
  nim_price_usd_nanos: DbNumeric
  service_fee_bps: number
  service_fee_luna: DbNumeric
  relay_cost_luna: DbNumeric
  payment_amount_luna: DbNumeric
  price_source: string
  created_at: DbTimestamp
  expires_at: DbTimestamp
  consumed_at: DbTimestamp | null
  consumed_order_id: string | null
}

function toBigInt(value: unknown) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string') return BigInt(value)
  throw new Error('Database returned an invalid integer.')
}

function toMillis(value: unknown) {
  const millis = value instanceof Date ? value.getTime() : new Date(String(value)).getTime()
  if (!Number.isFinite(millis)) throw new Error('Database returned an invalid timestamp.')
  return millis
}

function optionalBigInt(value: unknown) {
  return value === null || value === undefined ? undefined : toBigInt(value)
}

function optionalNumber(value: unknown) {
  return value === null || value === undefined ? undefined : Number(value)
}

function mapOrder(row: DbOrderRow): NimfuelOrder {
  return {
    id: row.id,
    reference: row.reference,
    expectedPaymentDataHex: row.expected_payment_data_hex,
    nimAddress: row.nim_address,
    paymentRecipient: row.payment_recipient,
    paymentAmountLuna: toBigInt(row.payment_amount_luna),
    evmAddress: row.evm_address,
    recipient: row.recipient,
    amountRaw: toBigInt(row.amount_raw),
    state: row.state as OrderState,
    createdAt: toMillis(row.created_at),
    expiresAt: toMillis(row.expires_at),
    updatedAt: toMillis(row.updated_at),
    paymentTxHash: row.payment_tx_hash || undefined,
    paymentBlockNumber: optionalNumber(row.payment_block_number),
    paymentConfirmations: row.payment_confirmations ?? undefined,
    paymentVerifiedAt: row.payment_verified_at ? toMillis(row.payment_verified_at) : undefined,
    relayAuthorizationDigest: row.relay_authorization_digest || undefined,
    relayTxHash: row.relay_tx_hash || undefined,
    relayBlockNumber: optionalNumber(row.relay_block_number),
    relaySubmittedAt: row.relay_submitted_at ? toMillis(row.relay_submitted_at) : undefined,
    relayVerifiedAt: row.relay_verified_at ? toMillis(row.relay_verified_at) : undefined,
    quoteId: row.quote_id || undefined,
    quoteAuthorizationDigest: row.quote_authorization_digest || undefined,
    quoteGasEstimate: optionalBigInt(row.quote_gas_estimate),
    quoteGasPrice: optionalBigInt(row.quote_gas_price),
    quoteEstimatedFeeRaw: optionalBigInt(row.quote_estimated_fee_raw),
    quotePolPriceUsdNanos: optionalBigInt(row.quote_pol_price_usd_nanos),
    quoteNimPriceUsdNanos: optionalBigInt(row.quote_nim_price_usd_nanos),
    quoteServiceFeeBps: row.quote_service_fee_bps ?? undefined,
    quoteServiceFeeLuna: optionalBigInt(row.quote_service_fee_luna),
    quotePaymentAmountLuna: optionalBigInt(row.quote_payment_amount_luna),
    quoteRelayCostLuna: optionalBigInt(row.quote_relay_cost_luna),
    quotePriceSource: row.quote_price_source || undefined,
    quoteCreatedAt: row.quote_created_at ? toMillis(row.quote_created_at) : undefined,
    quoteExpiresAt: row.quote_expires_at ? toMillis(row.quote_expires_at) : undefined,
    refundRecipient: row.refund_recipient || undefined,
    refundAmountLuna: optionalBigInt(row.refund_amount_luna),
    refundRequestedAt: row.refund_requested_at ? toMillis(row.refund_requested_at) : undefined,
    refundTxHash: row.refund_tx_hash || undefined,
    refundBlockNumber: optionalNumber(row.refund_block_number),
    refundConfirmations: row.refund_confirmations ?? undefined,
    refundVerifiedAt: row.refund_verified_at ? toMillis(row.refund_verified_at) : undefined,
    refundLastError: row.refund_last_error || undefined,
    lastError: row.last_error || undefined,
  }
}

function mapRelayAttempt(row: DbRelayAttemptRow): RelayAttempt {
  return {
    id: toBigInt(row.id).toString(),
    orderId: row.order_id,
    authorizationDigest: row.authorization_digest,
    nonce: toBigInt(row.nonce),
    deadline: toBigInt(row.deadline),
    userAddress: row.user_address,
    recipient: row.recipient,
    amountRaw: toBigInt(row.amount_raw),
    decimals: row.decimals,
    functionSignature: row.function_signature,
    signature: row.signature,
    executeData: row.execute_data,
    gasEstimate: toBigInt(row.gas_estimate),
    gasPrice: toBigInt(row.gas_price),
    estimatedFeeRaw: toBigInt(row.estimated_fee_raw),
    relayerAddress: row.relayer_address,
    status: row.status as RelayAttemptStatus,
    txHash: row.tx_hash || undefined,
    receiptStatus: row.receipt_status || undefined,
    blockNumber: optionalNumber(row.block_number),
    gasUsed: optionalBigInt(row.gas_used),
    transferVerified: row.transfer_verified ?? undefined,
    nonceAdvanced: row.nonce_advanced ?? undefined,
    createdAt: toMillis(row.created_at),
    submittedAt: row.submitted_at ? toMillis(row.submitted_at) : undefined,
    confirmedAt: row.confirmed_at ? toMillis(row.confirmed_at) : undefined,
    lastError: row.last_error || undefined,
  }
}

function mapQuote(row: DbQuoteRow): NimQuote {
  return {
    id: row.id,
    authorizationDigest: row.authorization_digest,
    userAddress: row.user_address,
    recipient: row.recipient,
    amountRaw: toBigInt(row.amount_raw),
    nonce: toBigInt(row.nonce),
    deadline: toBigInt(row.deadline),
    decimals: row.decimals,
    functionSignature: row.function_signature,
    signature: row.signature,
    executeData: row.execute_data,
    gasEstimate: toBigInt(row.gas_estimate),
    gasPrice: toBigInt(row.gas_price),
    estimatedFeeRaw: toBigInt(row.estimated_fee_raw),
    relayerAddress: row.relayer_address,
    polPriceUsdNanos: toBigInt(row.pol_price_usd_nanos),
    nimPriceUsdNanos: toBigInt(row.nim_price_usd_nanos),
    serviceFeeBps: row.service_fee_bps,
    serviceFeeLuna: toBigInt(row.service_fee_luna),
    relayCostLuna: toBigInt(row.relay_cost_luna),
    paymentAmountLuna: toBigInt(row.payment_amount_luna),
    priceSource: row.price_source,
    createdAt: toMillis(row.created_at),
    expiresAt: toMillis(row.expires_at),
    consumedAt: row.consumed_at ? toMillis(row.consumed_at) : undefined,
    consumedOrderId: row.consumed_order_id || undefined,
  }
}

export async function getQuoteById(id: string) {
  const result = await pool.query<DbQuoteRow>('SELECT * FROM quotes WHERE id = $1', [id])
  return result.rows[0] ? mapQuote(result.rows[0]) : null
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

export class DuplicateNimPaymentError extends Error {
  constructor() {
    super('This NIM payment transaction has already been used by another order.')
    this.name = 'DuplicateNimPaymentError'
  }
}

export class DuplicateRefundError extends Error {
  constructor() {
    super('This NIM refund transaction has already been used by another order.')
    this.name = 'DuplicateRefundError'
  }
}

export async function createQuote(input: {
  authorization: Omit<RelayAuthorizationRecord, 'orderId'>
  polPriceUsdNanos: bigint
  nimPriceUsdNanos: bigint
  serviceFeeBps: number
  serviceFeeLuna: bigint
  relayCostLuna: bigint
  paymentAmountLuna: bigint
  priceSource: string
  ttlSeconds: number
}) {
  const id = `q_${randomUUID().replaceAll('-', '')}`
  const createdAt = Date.now()
  const expiresAt = createdAt + input.ttlSeconds * 1000
  const result = await pool.query<DbQuoteRow>(
    `INSERT INTO quotes (
      id,
      authorization_digest,
      user_address,
      recipient,
      amount_raw,
      nonce,
      deadline,
      decimals,
      function_signature,
      signature,
      execute_data,
      gas_estimate,
      gas_price,
      estimated_fee_raw,
      relayer_address,
      pol_price_usd_nanos,
      nim_price_usd_nanos,
      service_fee_bps,
      service_fee_luna,
      relay_cost_luna,
      payment_amount_luna,
      price_source,
      created_at,
      expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
    ON CONFLICT (authorization_digest) DO UPDATE SET
      user_address = EXCLUDED.user_address,
      recipient = EXCLUDED.recipient,
      amount_raw = EXCLUDED.amount_raw,
      nonce = EXCLUDED.nonce,
      deadline = EXCLUDED.deadline,
      decimals = EXCLUDED.decimals,
      function_signature = EXCLUDED.function_signature,
      signature = EXCLUDED.signature,
      execute_data = EXCLUDED.execute_data,
      gas_estimate = EXCLUDED.gas_estimate,
      gas_price = EXCLUDED.gas_price,
      estimated_fee_raw = EXCLUDED.estimated_fee_raw,
      relayer_address = EXCLUDED.relayer_address,
      pol_price_usd_nanos = EXCLUDED.pol_price_usd_nanos,
      nim_price_usd_nanos = EXCLUDED.nim_price_usd_nanos,
      service_fee_bps = EXCLUDED.service_fee_bps,
      service_fee_luna = EXCLUDED.service_fee_luna,
      relay_cost_luna = EXCLUDED.relay_cost_luna,
      payment_amount_luna = EXCLUDED.payment_amount_luna,
      price_source = EXCLUDED.price_source,
      created_at = EXCLUDED.created_at,
      expires_at = EXCLUDED.expires_at
    WHERE quotes.consumed_order_id IS NULL
    RETURNING *`,
    [
      id,
      input.authorization.authorizationDigest,
      input.authorization.userAddress,
      input.authorization.recipient,
      input.authorization.amountRaw.toString(),
      input.authorization.nonce.toString(),
      input.authorization.deadline.toString(),
      input.authorization.decimals,
      input.authorization.functionSignature,
      input.authorization.signature,
      input.authorization.executeData,
      input.authorization.gasEstimate.toString(),
      input.authorization.gasPrice.toString(),
      input.authorization.estimatedFeeRaw.toString(),
      input.authorization.relayerAddress,
      input.polPriceUsdNanos.toString(),
      input.nimPriceUsdNanos.toString(),
      input.serviceFeeBps,
      input.serviceFeeLuna.toString(),
      input.relayCostLuna.toString(),
      input.paymentAmountLuna.toString(),
      input.priceSource,
      new Date(createdAt),
      new Date(expiresAt),
    ],
  )
  if (result.rows[0]) return mapQuote(result.rows[0])
  const existing = await pool.query<{ consumed_order_id: string | null }>(
    'SELECT consumed_order_id FROM quotes WHERE authorization_digest = $1',
    [input.authorization.authorizationDigest],
  )
  if (existing.rows[0]?.consumed_order_id) {
    throw new Error('This authorization has already created an order. Continue that order instead of creating another.')
  }
  throw new Error('The authorization quote could not be persisted.')
}

export function publicQuote(quote: NimQuote) {
  return {
    quoteId: quote.id,
    authorizationDigest: quote.authorizationDigest,
    userAddress: quote.userAddress,
    recipient: quote.recipient,
    amountRaw: quote.amountRaw.toString(),
    nonce: quote.nonce.toString(),
    deadline: quote.deadline.toString(),
    gasEstimate: quote.gasEstimate.toString(),
    gasPrice: quote.gasPrice.toString(),
    estimatedFeeRaw: quote.estimatedFeeRaw.toString(),
    estimatedFeePol: formatUnits(quote.estimatedFeeRaw, 18),
    polPriceUsd: formatUsdNanos(quote.polPriceUsdNanos),
    nimPriceUsd: formatUsdNanos(quote.nimPriceUsdNanos),
    serviceFeeBps: quote.serviceFeeBps,
    serviceFeeLuna: quote.serviceFeeLuna.toString(),
    serviceFeeNim: formatUnits(quote.serviceFeeLuna, 5),
    relayCostLuna: quote.relayCostLuna.toString(),
    relayCostNim: formatUnits(quote.relayCostLuna, 5),
    paymentAmountLuna: quote.paymentAmountLuna.toString(),
    paymentAmountNim: formatUnits(quote.paymentAmountLuna, 5),
    priceSource: quote.priceSource,
    createdAt: new Date(quote.createdAt).toISOString(),
    expiresAt: new Date(quote.expiresAt).toISOString(),
  }
}

export async function createOrder(input: {
  nimAddress: string
  paymentRecipient: string
  paymentAmountLuna: bigint
  evmAddress: string
  recipient: string
  amountRaw: bigint
  ttlSeconds: number
}) {
  const id = `nf_${randomUUID().replaceAll('-', '')}`
  const reference = `NIMFUEL:${id}`
  const now = Date.now()
  const result = await pool.query<DbOrderRow>(
    `INSERT INTO orders (
      id,
      reference,
      expected_payment_data_hex,
      nim_address,
      payment_recipient,
      payment_amount_luna,
      evm_address,
      recipient,
      amount_raw,
      state,
      created_at,
      expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'AWAITING_NIM_PAYMENT', $10, $11)
    RETURNING *`,
    [
      id,
      reference,
      encodeNimReference(reference),
      input.nimAddress,
      formatNimAddress(input.paymentRecipient),
      input.paymentAmountLuna.toString(),
      input.evmAddress,
      input.recipient,
      input.amountRaw.toString(),
      new Date(now),
      new Date(now + input.ttlSeconds * 1000),
    ],
  )
  return mapOrder(result.rows[0])
}

export async function createOrderFromQuote(input: {
  nimAddress: string
  paymentRecipient: string
  quoteId: string
}) {
  return await withTransaction(async client => {
    const quoteResult = await client.query<DbQuoteRow>('SELECT * FROM quotes WHERE id = $1 FOR UPDATE', [input.quoteId])
    const quoteRow = quoteResult.rows[0]
    if (!quoteRow) throw new Error('Quote was not found.')

    const quote = mapQuote(quoteRow)
    if (quote.consumedOrderId) throw new Error('This quote has already been used.')
    if (Date.now() >= quote.expiresAt) throw new Error('This quote has expired. Prepare a new quote.')

    const activeNonceResult = await client.query<{ id: string; state: OrderState }>(
      `SELECT o.id, o.state
       FROM orders o
       JOIN quotes consumed_quote ON consumed_quote.consumed_order_id = o.id
       WHERE LOWER(consumed_quote.user_address) = LOWER($1)
         AND consumed_quote.nonce = $2
         AND o.state NOT IN ('PAYMENT_EXPIRED', 'FULFILLED', 'REFUNDED')
       ORDER BY o.created_at DESC
       LIMIT 1
       FOR UPDATE OF o`,
      [quote.userAddress, quote.nonce.toString()],
    )
    if (activeNonceResult.rows[0]) {
      throw new Error(`This wallet already has an active order for authorization nonce ${quote.nonce.toString()}. Finish or recover that order before creating another.`)
    }

    const id = `nf_${randomUUID().replaceAll('-', '')}`
    const reference = `NIMFUEL:${id}`
    const now = Date.now()
    const orderResult = await client.query<DbOrderRow>(
      `INSERT INTO orders (
        id,
        reference,
        expected_payment_data_hex,
        nim_address,
        payment_recipient,
        payment_amount_luna,
        evm_address,
        recipient,
        amount_raw,
        state,
        created_at,
        expires_at,
        quote_id,
        quote_authorization_digest,
        quote_gas_estimate,
        quote_gas_price,
        quote_estimated_fee_raw,
        quote_pol_price_usd_nanos,
        quote_nim_price_usd_nanos,
        quote_service_fee_bps,
        quote_service_fee_luna,
        quote_payment_amount_luna,
        quote_relay_cost_luna,
        quote_price_source,
        quote_created_at,
        quote_expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'AWAITING_NIM_PAYMENT', $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
      RETURNING *`,
      [
        id,
        reference,
        encodeNimReference(reference),
        input.nimAddress,
        formatNimAddress(input.paymentRecipient),
        quote.paymentAmountLuna.toString(),
        quote.userAddress,
        quote.recipient,
        quote.amountRaw.toString(),
        new Date(now),
        new Date(quote.expiresAt),
        quote.id,
        quote.authorizationDigest,
        quote.gasEstimate.toString(),
        quote.gasPrice.toString(),
        quote.estimatedFeeRaw.toString(),
        quote.polPriceUsdNanos.toString(),
        quote.nimPriceUsdNanos.toString(),
        quote.serviceFeeBps,
        quote.serviceFeeLuna.toString(),
        quote.paymentAmountLuna.toString(),
        quote.relayCostLuna.toString(),
        quote.priceSource,
        new Date(quote.createdAt),
        new Date(quote.expiresAt),
      ],
    )

    const consumed = await client.query(
      `UPDATE quotes
       SET consumed_at = NOW(), consumed_order_id = $2
       WHERE id = $1 AND consumed_order_id IS NULL`,
      [quote.id, id],
    )
    if (consumed.rowCount !== 1) throw new Error('The quote was consumed before the order could be created.')
    return mapOrder(orderResult.rows[0])
  })
}

export async function getOrder(id: string) {
  const result = await pool.query<DbOrderRow>('SELECT * FROM orders WHERE id = $1', [id])
  return result.rows[0] ? mapOrder(result.rows[0]) : null
}

export async function getOrderByReference(reference: string) {
  const result = await pool.query<DbOrderRow>('SELECT * FROM orders WHERE reference = $1', [reference])
  return result.rows[0] ? mapOrder(result.rows[0]) : null
}

export async function getOrdersByEvmAddress(evmAddress: string, limit: number) {
  const result = await pool.query<DbOrderRow>(
    `SELECT * FROM orders
     WHERE LOWER(evm_address) = LOWER($1)
     ORDER BY created_at DESC
     LIMIT $2`,
    [evmAddress, limit],
  )
  return result.rows.map(mapOrder)
}

export async function getRelayAttemptsByOrderId(orderId: string) {
  const result = await pool.query<DbRelayAttemptRow>(
    'SELECT * FROM relay_attempts WHERE order_id = $1 ORDER BY created_at ASC',
    [orderId],
  )
  return result.rows.map(mapRelayAttempt)
}

export async function getRelayAttemptCount(orderId: string) {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM relay_attempts WHERE order_id = $1',
    [orderId],
  )
  return Number(result.rows[0]?.count || '0')
}

export async function markPaymentExpired(orderId: string, message: string) {
  const result = await pool.query<DbOrderRow>(
    `UPDATE orders
     SET state = 'PAYMENT_EXPIRED', last_error = $2, updated_at = NOW()
     WHERE id = $1
       AND state IN ('AWAITING_NIM_PAYMENT', 'PAYMENT_MISMATCH', 'NIM_PAYMENT_CONFIRMED')
     RETURNING *`,
    [orderId, message],
  )
  return result.rows[0] ? mapOrder(result.rows[0]) : null
}

export async function markPaymentMismatch(orderId: string, message: string) {
  const result = await pool.query<DbOrderRow>(
    `UPDATE orders
     SET state = 'PAYMENT_MISMATCH', last_error = $2, updated_at = NOW()
     WHERE id = $1 AND payment_tx_hash IS NULL
     RETURNING *`,
    [orderId, message],
  )
  return result.rows[0] ? mapOrder(result.rows[0]) : null
}

export async function confirmNimPayment(input: {
  orderId: string
  txHash: string
  blockNumber: number
  confirmations: number
}) {
  try {
    return await withTransaction(async client => {
      const existingResult = await client.query<DbOrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [input.orderId])
      const existingRow = existingResult.rows[0]
      if (!existingRow) throw new Error('Order was not found.')

      const existingOrder = mapOrder(existingRow)
      if (existingOrder.paymentTxHash) {
        if (existingOrder.paymentTxHash === input.txHash) return existingOrder
        throw new Error('This order already has a different payment transaction.')
      }
      if (existingOrder.state === 'PAYMENT_EXPIRED') {
        throw new Error('This NIM payment order has expired.')
      }
      if (!['AWAITING_NIM_PAYMENT', 'PAYMENT_MISMATCH'].includes(existingOrder.state)) {
        throw new Error('This order is not available for NIM payment confirmation.')
      }

      const result = await client.query<DbOrderRow>(
        `UPDATE orders
         SET state = 'NIM_PAYMENT_CONFIRMED',
             payment_tx_hash = $2,
             payment_block_number = $3,
             payment_confirmations = $4,
             payment_verified_at = NOW(),
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1 AND payment_tx_hash IS NULL
         RETURNING *`,
        [input.orderId, input.txHash, input.blockNumber, input.confirmations],
      )
      if (!result.rows[0]) throw new Error('The order changed before payment confirmation.')
      return mapOrder(result.rows[0])
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateNimPaymentError()
    throw error
  }
}

export async function getRelayAttemptByDigest(authorizationDigest: string) {
  const result = await pool.query<DbRelayAttemptRow>(
    'SELECT * FROM relay_attempts WHERE authorization_digest = $1',
    [authorizationDigest],
  )
  return result.rows[0] ? mapRelayAttempt(result.rows[0]) : null
}

export async function reserveRelayAttempt(orderId: string, input: RelayAuthorizationRecord): Promise<RelayReservation> {
  try {
    const reservation = await withTransaction<RelayReservation | null>(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['81520314'])

      const orderResult = await client.query<DbOrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
      const orderRow = orderResult.rows[0]
      if (!orderRow) throw new Error('Order was not found.')
      const order = mapOrder(orderRow)

      const existingResult = await client.query<DbRelayAttemptRow>(
        'SELECT * FROM relay_attempts WHERE authorization_digest = $1 FOR UPDATE',
        [input.authorizationDigest],
      )
      if (existingResult.rows[0]) {
        const existing = mapRelayAttempt(existingResult.rows[0])
        if (existing.orderId !== orderId) {
          throw new Error('This authorization has already been reserved for another order.')
        }
        return { created: false, order, attempt: existing }
      }

      if (order.state === 'FULFILLED') throw new Error('This order has already been fulfilled.')
      if (['RELAY_BROADCASTING', 'RELAY_SUBMITTED', 'RECOVERY_REQUIRED'].includes(order.state)) {
        throw new Error('This order already has a relay attempt that requires reconciliation.')
      }
      if (!['NIM_PAYMENT_CONFIRMED', 'RELAY_FAILED'].includes(order.state)) {
        throw new Error('The NIM payment must be independently confirmed before relay execution.')
      }
      if (Date.now() >= order.expiresAt) {
        await client.query(
          `UPDATE orders
           SET state = 'PAYMENT_EXPIRED', last_error = $2, updated_at = NOW()
           WHERE id = $1`,
          [orderId, 'The order expired before Polygon fulfillment.'],
        )
        throw new Error('This NIM payment order has expired before relay execution.')
      }

      const countResult = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM relay_attempts WHERE order_id = $1',
        [orderId],
      )
      if (Number(countResult.rows[0]?.count || '0') >= config.relayMaxAttempts) {
        await client.query(
          `UPDATE orders
           SET state = 'RECOVERY_REQUIRED',
               last_error = $2,
               updated_at = NOW()
           WHERE id = $1 AND state IN ('NIM_PAYMENT_CONFIRMED', 'RELAY_FAILED')`,
          [orderId, 'The relay attempt limit was reached. Manual recovery or refund is required.'],
        )
        return null
      }

      const attemptResult = await client.query<DbRelayAttemptRow>(
        `INSERT INTO relay_attempts (
          order_id,
          authorization_digest,
          nonce,
          deadline,
          user_address,
          recipient,
          amount_raw,
          decimals,
          function_signature,
          signature,
          execute_data,
          gas_estimate,
          gas_price,
          estimated_fee_raw,
          relayer_address,
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'BROADCASTING')
        RETURNING *`,
        [
          orderId,
          input.authorizationDigest,
          input.nonce.toString(),
          input.deadline.toString(),
          input.userAddress,
          input.recipient,
          input.amountRaw.toString(),
          input.decimals,
          input.functionSignature,
          input.signature,
          input.executeData,
          input.gasEstimate.toString(),
          input.gasPrice.toString(),
          input.estimatedFeeRaw.toString(),
          input.relayerAddress,
        ],
      )
      const updatedOrderResult = await client.query<DbOrderRow>(
        `UPDATE orders
         SET state = 'RELAY_BROADCASTING',
             relay_authorization_digest = $2,
             relay_tx_hash = NULL,
             relay_block_number = NULL,
             relay_submitted_at = NULL,
             relay_verified_at = NULL,
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [orderId, input.authorizationDigest],
      )
      if (!updatedOrderResult.rows[0]) throw new Error('The order changed before relay reservation.')
      return {
        created: true,
        order: mapOrder(updatedOrderResult.rows[0]),
        attempt: mapRelayAttempt(attemptResult.rows[0]),
      }
    })
    if (!reservation) throw new Error('The configured live relay attempt limit has been reached.')
    return reservation
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error('This relay authorization has already been reserved.')
    }
    throw error
  }
}

export async function recordRelaySubmission(orderId: string, authorizationDigest: string, txHash: string) {
  return await withTransaction(async client => {
    const attemptResult = await client.query<DbRelayAttemptRow>(
      'SELECT * FROM relay_attempts WHERE order_id = $1 AND authorization_digest = $2 FOR UPDATE',
      [orderId, authorizationDigest],
    )
    const attemptRow = attemptResult.rows[0]
    if (!attemptRow) throw new Error('Relay attempt reservation was not found.')

    const currentAttempt = mapRelayAttempt(attemptRow)
    if (currentAttempt.txHash) {
      if (currentAttempt.txHash === txHash) {
        const order = await getOrderForClient(client, orderId)
        return { order, attempt: currentAttempt }
      }
      throw new Error('This relay attempt already has a different transaction hash.')
    }
    if (currentAttempt.status !== 'BROADCASTING') {
      throw new Error('This relay attempt is no longer waiting for a transaction hash.')
    }

    const updatedAttemptResult = await client.query<DbRelayAttemptRow>(
      `UPDATE relay_attempts
       SET status = 'SUBMITTED', tx_hash = $3, submitted_at = COALESCE(submitted_at, NOW()), last_error = NULL, updated_at = NOW()
       WHERE order_id = $1 AND authorization_digest = $2 AND tx_hash IS NULL
       RETURNING *`,
      [orderId, authorizationDigest, txHash],
    )
    const updatedOrderResult = await client.query<DbOrderRow>(
      `UPDATE orders
       SET state = 'RELAY_SUBMITTED', relay_tx_hash = $3, relay_submitted_at = COALESCE(relay_submitted_at, NOW()), last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND relay_authorization_digest = $2
       RETURNING *`,
      [orderId, authorizationDigest, txHash],
    )
    if (!updatedAttemptResult.rows[0] || !updatedOrderResult.rows[0]) {
      throw new Error('The relay submission could not be persisted.')
    }
    return {
      order: mapOrder(updatedOrderResult.rows[0]),
      attempt: mapRelayAttempt(updatedAttemptResult.rows[0]),
    }
  })
}

export async function recordRelayOutcome(orderId: string, authorizationDigest: string, outcome: RelayOutcome) {
  return await withTransaction(async client => {
    const attemptResult = await client.query<DbRelayAttemptRow>(
      'SELECT * FROM relay_attempts WHERE order_id = $1 AND authorization_digest = $2 FOR UPDATE',
      [orderId, authorizationDigest],
    )
    if (!attemptResult.rows[0]) throw new Error('Relay attempt was not found.')

    const currentAttempt = mapRelayAttempt(attemptResult.rows[0])
    const currentOrder = await getOrderForClient(client, orderId)
    if (['REFUND_PENDING', 'REFUNDED'].includes(currentOrder.state)) {
      if (currentAttempt.status === outcome.status) return { order: currentOrder, attempt: currentAttempt }
      throw new Error('This relay attempt cannot change after refund processing has started.')
    }
    if (['CONFIRMED', 'FAILED', 'RECOVERY_REQUIRED'].includes(currentAttempt.status) && currentAttempt.status !== outcome.status) {
      if (currentOrder.relayAuthorizationDigest !== authorizationDigest) {
        throw new Error('This relay attempt is no longer the current order attempt.')
      }
      return { order: currentOrder, attempt: currentAttempt }
    }

    const orderState: OrderState = outcome.status === 'CONFIRMED'
      ? 'FULFILLED'
      : outcome.status === 'FAILED'
        ? 'RELAY_FAILED'
        : outcome.status === 'RECOVERY_REQUIRED'
          ? 'RECOVERY_REQUIRED'
          : 'RELAY_SUBMITTED'
    const terminal = outcome.status === 'CONFIRMED' || outcome.status === 'FAILED' || outcome.status === 'RECOVERY_REQUIRED'
    const attemptUpdate = await client.query<DbRelayAttemptRow>(
      `UPDATE relay_attempts
       SET status = $3,
           receipt_status = COALESCE($4, receipt_status),
           block_number = COALESCE($5, block_number),
           gas_used = COALESCE($6, gas_used),
           transfer_verified = COALESCE($7, transfer_verified),
           nonce_advanced = COALESCE($8, nonce_advanced),
           confirmed_at = CASE WHEN $9 THEN COALESCE(confirmed_at, NOW()) ELSE confirmed_at END,
           last_error = $10,
           updated_at = NOW()
       WHERE order_id = $1 AND authorization_digest = $2
       RETURNING *`,
      [
        orderId,
        authorizationDigest,
        outcome.status,
        outcome.receiptStatus ?? null,
        outcome.blockNumber?.toString() ?? null,
        outcome.gasUsed?.toString() ?? null,
        outcome.transferVerified ?? null,
        outcome.nonceAdvanced ?? null,
        terminal,
        outcome.error ?? null,
      ],
    )
    const orderUpdate = await client.query<DbOrderRow>(
      `UPDATE orders
       SET state = $3,
           relay_block_number = COALESCE($4, relay_block_number),
           relay_verified_at = CASE WHEN $5 THEN COALESCE(relay_verified_at, NOW()) ELSE relay_verified_at END,
           last_error = $6,
           updated_at = NOW()
       WHERE id = $1 AND relay_authorization_digest = $2
       RETURNING *`,
      [
        orderId,
        authorizationDigest,
        orderState,
        outcome.blockNumber?.toString() ?? null,
        outcome.status === 'CONFIRMED',
        outcome.error ?? null,
      ],
    )
    if (!attemptUpdate.rows[0] || !orderUpdate.rows[0]) throw new Error('The relay outcome could not be persisted.')
    return {
      order: mapOrder(orderUpdate.rows[0]),
      attempt: mapRelayAttempt(attemptUpdate.rows[0]),
    }
  })
}

export async function requestRefund(orderId: string) {
  return await withTransaction(async client => {
    const orderResult = await client.query<DbOrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
    const orderRow = orderResult.rows[0]
    if (!orderRow) throw new Error('Order was not found.')

    const order = mapOrder(orderRow)
    if (!order.paymentTxHash) throw new Error('A refund can only be requested for a paid order.')
    if (order.state === 'REFUNDED') throw new Error('This order has already been refunded.')
    if (order.state === 'FULFILLED') throw new Error('A fulfilled order cannot be refunded.')
    if (order.state === 'REFUND_PENDING') return order
    if (!['NIM_PAYMENT_CONFIRMED', 'PAYMENT_EXPIRED', 'RELAY_FAILED', 'RECOVERY_REQUIRED'].includes(order.state)) {
      throw new Error('This order is not in a refundable state.')
    }

    const activeAttempt = await client.query<{ status: string }>(
      `SELECT status FROM relay_attempts
       WHERE order_id = $1 AND status IN ('BROADCASTING', 'SUBMITTED')
       LIMIT 1`,
      [orderId],
    )
    if (activeAttempt.rows[0]) throw new Error('Reconcile the pending Polygon relay before requesting a refund.')

    const result = await client.query<DbOrderRow>(
      `UPDATE orders
       SET state = 'REFUND_PENDING',
           refund_recipient = nim_address,
           refund_amount_luna = payment_amount_luna,
           refund_requested_at = COALESCE(refund_requested_at, NOW()),
           refund_last_error = NULL,
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1 AND state <> 'FULFILLED'
       RETURNING *`,
      [orderId],
    )
    if (!result.rows[0]) throw new Error('The refund request could not be persisted.')
    return mapOrder(result.rows[0])
  })
}

export async function recordRefundFailure(orderId: string, message: string) {
  const result = await pool.query<DbOrderRow>(
    `UPDATE orders
     SET refund_last_error = $2,
         last_error = $2,
         updated_at = NOW()
     WHERE id = $1 AND state = 'REFUND_PENDING'
     RETURNING *`,
    [orderId, message],
  )
  return result.rows[0] ? mapOrder(result.rows[0]) : null
}

export async function confirmRefund(input: {
  orderId: string
  txHash: string
  blockNumber: number
  confirmations: number
}) {
  try {
    return await withTransaction(async client => {
      const orderResult = await client.query<DbOrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [input.orderId])
      const orderRow = orderResult.rows[0]
      if (!orderRow) throw new Error('Order was not found.')

      const existing = mapOrder(orderRow)
      if (existing.state === 'REFUNDED') {
        if (existing.refundTxHash === input.txHash) return existing
        throw new Error('This order has already been refunded with a different transaction.')
      }
      if (existing.state !== 'REFUND_PENDING') throw new Error('This order does not have a pending refund.')
      if (existing.refundTxHash && existing.refundTxHash !== input.txHash) {
        throw new Error('This order already has a different refund transaction.')
      }

      const result = await client.query<DbOrderRow>(
        `UPDATE orders
         SET state = 'REFUNDED',
             refund_tx_hash = $2,
             refund_block_number = $3,
             refund_confirmations = $4,
             refund_verified_at = NOW(),
             refund_last_error = NULL,
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1 AND state = 'REFUND_PENDING' AND refund_tx_hash IS NULL
         RETURNING *`,
        [input.orderId, input.txHash, input.blockNumber, input.confirmations],
      )
      if (!result.rows[0]) throw new Error('The refund changed before verification completed.')
      return mapOrder(result.rows[0])
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateRefundError()
    throw error
  }
}

export async function getOutstandingRelayAttempts() {
  const result = await pool.query<DbRelayAttemptRow>(
    `SELECT * FROM relay_attempts
     WHERE status IN ('BROADCASTING', 'SUBMITTED')
     ORDER BY created_at ASC`,
  )
  return result.rows.map(mapRelayAttempt)
}

export async function getOrdersReadyForAutoRefund(afterSeconds: number) {
  const result = await pool.query<DbOrderRow>(
    `SELECT * FROM orders
     WHERE state = 'RECOVERY_REQUIRED'
       AND payment_tx_hash IS NOT NULL
       AND refund_requested_at IS NULL
       AND updated_at <= NOW() - ($1::double precision * INTERVAL '1 second')
     ORDER BY updated_at ASC
     LIMIT 100`,
    [afterSeconds],
  )
  return result.rows.map(mapOrder)
}

export async function getOperationalMetrics() {
  const [ordersByState, relayByStatus, totals, relayTotals, lastActivity] = await Promise.all([
    pool.query<{ state: string; count: string }>('SELECT state, COUNT(*)::text AS count FROM orders GROUP BY state ORDER BY state'),
    pool.query<{ status: string; count: string }>('SELECT status, COUNT(*)::text AS count FROM relay_attempts GROUP BY status ORDER BY status'),
    pool.query<{ total: string; paid: string; fulfilled: string; recovered: string; refunded: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE payment_tx_hash IS NOT NULL)::text AS paid,
         COUNT(*) FILTER (WHERE state = 'FULFILLED')::text AS fulfilled,
         COUNT(*) FILTER (WHERE state = 'RECOVERY_REQUIRED')::text AS recovered,
         COUNT(*) FILTER (WHERE state = 'REFUNDED')::text AS refunded
       FROM orders`,
    ),
    pool.query<{ total: string; confirmed: string; failed: string; gas_used: string; estimated_fee: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE status = 'CONFIRMED')::text AS confirmed,
         COUNT(*) FILTER (WHERE status IN ('FAILED', 'RECOVERY_REQUIRED'))::text AS failed,
         COALESCE(SUM(gas_used), 0)::text AS gas_used,
         COALESCE(SUM(estimated_fee_raw), 0)::text AS estimated_fee
       FROM relay_attempts`,
    ),
    pool.query<{ updated_at: DbTimestamp | null }>('SELECT MAX(updated_at) AS updated_at FROM orders'),
  ])

  const byState = Object.fromEntries(ordersByState.rows.map(row => [row.state, Number(row.count)]))
  const byStatus = Object.fromEntries(relayByStatus.rows.map(row => [row.status, Number(row.count)]))
  const orderTotals = totals.rows[0]
  const relaySummary = relayTotals.rows[0]
  const latest = lastActivity.rows[0]?.updated_at

  return {
    generatedAt: new Date().toISOString(),
    orders: {
      total: Number(orderTotals?.total || '0'),
      paid: Number(orderTotals?.paid || '0'),
      fulfilled: Number(orderTotals?.fulfilled || '0'),
      recoveryRequired: Number(orderTotals?.recovered || '0'),
      refunded: Number(orderTotals?.refunded || '0'),
      byState,
    },
    relayAttempts: {
      total: Number(relaySummary?.total || '0'),
      confirmed: Number(relaySummary?.confirmed || '0'),
      failedOrRecovery: Number(relaySummary?.failed || '0'),
      byStatus,
      gasUsedRaw: relaySummary?.gas_used || '0',
      estimatedFeeRaw: relaySummary?.estimated_fee || '0',
    },
    lastOrderActivityAt: latest ? new Date(toMillis(latest)).toISOString() : null,
  }
}

async function getOrderForClient(client: PoolClient, orderId: string) {
  const result = await client.query<DbOrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
  if (!result.rows[0]) throw new Error('Order was not found.')
  return mapOrder(result.rows[0])
}

export function publicOrder(order: NimfuelOrder) {
  return {
    orderId: order.id,
    reference: order.reference,
    paymentDataHex: order.expectedPaymentDataHex,
    nimAddress: order.nimAddress,
    paymentRecipient: order.paymentRecipient,
    paymentAmountLuna: order.paymentAmountLuna.toString(),
    paymentAmountNim: formatUnits(order.paymentAmountLuna, 5),
    evmAddress: order.evmAddress,
    recipient: order.recipient,
    amountRaw: order.amountRaw.toString(),
    state: order.state,
    createdAt: new Date(order.createdAt).toISOString(),
    expiresAt: new Date(order.expiresAt).toISOString(),
    updatedAt: new Date(order.updatedAt).toISOString(),
    paymentTxHash: order.paymentTxHash || null,
    paymentBlockNumber: order.paymentBlockNumber ?? null,
    paymentConfirmations: order.paymentConfirmations ?? null,
    paymentVerifiedAt: order.paymentVerifiedAt ? new Date(order.paymentVerifiedAt).toISOString() : null,
    relayAuthorizationDigest: order.relayAuthorizationDigest || null,
    relayTxHash: order.relayTxHash || null,
    relayBlockNumber: order.relayBlockNumber ?? null,
    relaySubmittedAt: order.relaySubmittedAt ? new Date(order.relaySubmittedAt).toISOString() : null,
    relayVerifiedAt: order.relayVerifiedAt ? new Date(order.relayVerifiedAt).toISOString() : null,
    quoteId: order.quoteId || null,
    quoteAuthorizationDigest: order.quoteAuthorizationDigest || null,
    quoteGasEstimate: order.quoteGasEstimate?.toString() ?? null,
    quoteGasPrice: order.quoteGasPrice?.toString() ?? null,
    quoteEstimatedFeeRaw: order.quoteEstimatedFeeRaw?.toString() ?? null,
    quotePolPriceUsdNanos: order.quotePolPriceUsdNanos?.toString() ?? null,
    quoteNimPriceUsdNanos: order.quoteNimPriceUsdNanos?.toString() ?? null,
    quoteServiceFeeBps: order.quoteServiceFeeBps ?? null,
    quoteServiceFeeLuna: order.quoteServiceFeeLuna?.toString() ?? null,
    quotePaymentAmountLuna: order.quotePaymentAmountLuna?.toString() ?? null,
    quoteRelayCostLuna: order.quoteRelayCostLuna?.toString() ?? null,
    quotePriceSource: order.quotePriceSource || null,
    quoteCreatedAt: order.quoteCreatedAt ? new Date(order.quoteCreatedAt).toISOString() : null,
    quoteExpiresAt: order.quoteExpiresAt ? new Date(order.quoteExpiresAt).toISOString() : null,
    refundRecipient: order.refundRecipient || null,
    refundAmountLuna: order.refundAmountLuna?.toString() ?? null,
    refundAmountNim: order.refundAmountLuna === undefined ? null : formatUnits(order.refundAmountLuna, 5),
    refundRequestedAt: order.refundRequestedAt ? new Date(order.refundRequestedAt).toISOString() : null,
    refundTxHash: order.refundTxHash || null,
    refundBlockNumber: order.refundBlockNumber ?? null,
    refundConfirmations: order.refundConfirmations ?? null,
    refundVerifiedAt: order.refundVerifiedAt ? new Date(order.refundVerifiedAt).toISOString() : null,
    refundLastError: order.refundLastError || null,
    lastError: order.lastError || null,
  }
}

export function publicOrderHistory(order: NimfuelOrder) {
  return {
    orderId: order.id,
    reference: order.reference,
    state: order.state,
    createdAt: new Date(order.createdAt).toISOString(),
    updatedAt: new Date(order.updatedAt).toISOString(),
    expiresAt: new Date(order.expiresAt).toISOString(),
    recipient: order.recipient,
    amountRaw: order.amountRaw.toString(),
    amountUsdt: formatUnits(order.amountRaw, USDT_DECIMALS),
    paymentAmountNim: formatUnits(order.paymentAmountLuna, 5),
    paymentTxHash: order.paymentTxHash || null,
    relayTxHash: order.relayTxHash || null,
    relayBlockNumber: order.relayBlockNumber ?? null,
    refundTxHash: order.refundTxHash || null,
    lastError: order.lastError || null,
  }
}
