import { randomUUID } from 'node:crypto'
import { pool, withTransaction } from './db.js'
import type { PoolClient } from 'pg'
import { config } from './config.js'
import { encodeNimReference, formatNimAddress } from './nim.js'

export type OrderState =
  | 'AWAITING_NIM_PAYMENT'
  | 'NIM_PAYMENT_CONFIRMED'
  | 'PAYMENT_EXPIRED'
  | 'PAYMENT_MISMATCH'
  | 'RELAY_BROADCASTING'
  | 'RELAY_SUBMITTED'
  | 'RELAY_FAILED'
  | 'RECOVERY_REQUIRED'
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
  paymentTxHash?: string
  paymentBlockNumber?: number
  paymentConfirmations?: number
  paymentVerifiedAt?: number
  relayAuthorizationDigest?: string
  relayTxHash?: string
  relayBlockNumber?: number
  relaySubmittedAt?: number
  relayVerifiedAt?: number
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
    paymentTxHash: row.payment_tx_hash || undefined,
    paymentBlockNumber: optionalNumber(row.payment_block_number),
    paymentConfirmations: row.payment_confirmations ?? undefined,
    paymentVerifiedAt: row.payment_verified_at ? toMillis(row.payment_verified_at) : undefined,
    relayAuthorizationDigest: row.relay_authorization_digest || undefined,
    relayTxHash: row.relay_tx_hash || undefined,
    relayBlockNumber: optionalNumber(row.relay_block_number),
    relaySubmittedAt: row.relay_submitted_at ? toMillis(row.relay_submitted_at) : undefined,
    relayVerifiedAt: row.relay_verified_at ? toMillis(row.relay_verified_at) : undefined,
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

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

export class DuplicateNimPaymentError extends Error {
  constructor() {
    super('This NIM payment transaction has already been used by another order.')
    this.name = 'DuplicateNimPaymentError'
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

export async function getOrder(id: string) {
  const result = await pool.query<DbOrderRow>('SELECT * FROM orders WHERE id = $1', [id])
  return result.rows[0] ? mapOrder(result.rows[0]) : null
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
    return await withTransaction(async client => {
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

      const countResult = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM relay_attempts')
      if (Number(countResult.rows[0]?.count || '0') >= config.liveRelayMaxAttempts) {
        throw new Error('The configured live relay attempt limit has been reached.')
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
    if (['CONFIRMED', 'FAILED', 'RECOVERY_REQUIRED'].includes(currentAttempt.status) && currentAttempt.status !== outcome.status) {
      const currentOrder = await getOrderForClient(client, orderId)
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

export async function getOutstandingRelayAttempts() {
  const result = await pool.query<DbRelayAttemptRow>(
    `SELECT * FROM relay_attempts
     WHERE status IN ('BROADCASTING', 'SUBMITTED')
     ORDER BY created_at ASC`,
  )
  return result.rows.map(mapRelayAttempt)
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
    paymentAmountNim: Number(order.paymentAmountLuna) / 100_000,
    evmAddress: order.evmAddress,
    recipient: order.recipient,
    amountRaw: order.amountRaw.toString(),
    state: order.state,
    createdAt: new Date(order.createdAt).toISOString(),
    expiresAt: new Date(order.expiresAt).toISOString(),
    paymentTxHash: order.paymentTxHash || null,
    paymentBlockNumber: order.paymentBlockNumber ?? null,
    paymentConfirmations: order.paymentConfirmations ?? null,
    paymentVerifiedAt: order.paymentVerifiedAt ? new Date(order.paymentVerifiedAt).toISOString() : null,
    relayAuthorizationDigest: order.relayAuthorizationDigest || null,
    relayTxHash: order.relayTxHash || null,
    relayBlockNumber: order.relayBlockNumber ?? null,
    relaySubmittedAt: order.relaySubmittedAt ? new Date(order.relaySubmittedAt).toISOString() : null,
    relayVerifiedAt: order.relayVerifiedAt ? new Date(order.relayVerifiedAt).toISOString() : null,
    lastError: order.lastError || null,
  }
}
