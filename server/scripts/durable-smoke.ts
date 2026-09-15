import { config } from '../src/config.js'
import { initializeDatabase, pool } from '../src/db.js'
import {
  confirmNimPayment,
  createOrder,
  DuplicateNimPaymentError,
  getRelayAttemptByDigest,
  getOrder,
  recordRelayOutcome,
  recordRelaySubmission,
  reserveRelayAttempt,
} from '../src/orders.js'

const apiBaseUrl = 'http://127.0.0.1:3001'
const nimAddress = 'NQ54RXNRPXPH3YXK144CSS31SKBUYYBU6NSJ'
const evmAddress = '0x83975720D8eCE69356dfCfe5a9900D2B850DaF26'
const amountRaw = 100_000n
const oldPaymentHash = '7228593499bc55177ca1deb90359a65367646d5cbc099c63b331ae0838887bb6'
const createdOrderIds: string[] = []

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  const body = await response.json() as Record<string, unknown>
  return { status: response.status, body }
}

async function apiOrder() {
  const result = await request('/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nimAddress, evmAddress, recipient: evmAddress, amountRaw: amountRaw.toString() }),
  })
  assert(result.status === 201 && typeof result.body.orderId === 'string', 'Could not create a smoke-test order.')
  createdOrderIds.push(result.body.orderId)
  return result.body.orderId
}

function directOrder() {
  return createOrder({
    nimAddress,
    paymentRecipient: config.nimRecipient!,
    paymentAmountLuna: config.nimPaymentAmountLuna!,
    evmAddress,
    recipient: evmAddress,
    amountRaw,
    ttlSeconds: 900,
  }).then(order => {
    createdOrderIds.push(order.id)
    return order
  })
}

function authorization(orderId: string, digestByte: string) {
  return {
    orderId,
    authorizationDigest: `0x${digestByte.repeat(32)}`,
    nonce: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 900),
    userAddress: evmAddress,
    recipient: evmAddress,
    amountRaw,
    decimals: 6,
    functionSignature: '0x1234',
    signature: `0x${'22'.repeat(65)}`,
    executeData: '0x1234',
    gasEstimate: 70_000n,
    gasPrice: 30_000_000_000n,
    estimatedFeeRaw: 2_100_000_000_000_000n,
    relayerAddress: '0x8093e0c4e2f6E6e7c7F6f4c5d1c2B9a8A4B036e8',
  }
}

async function main() {
  await initializeDatabase()

  const invalidAmount = await request('/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nimAddress, evmAddress, recipient: evmAddress, amountRaw: '0' }),
  })
  assert(invalidAmount.status === 400, 'An invalid zero amount was accepted.')
  console.log('invalid amounts: pass')

  const unpaidOrderId = await apiOrder()
  const unpaidRelay = await request('/v1/relay/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: unpaidOrderId }),
  })
  assert(unpaidRelay.status === 400, 'An unpaid order reached relay execution.')
  console.log('unpaid relay gate: pass')

  const mismatchOrderId = await apiOrder()
  const mismatch = await request(`/v1/orders/${mismatchOrderId}/verify-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash: oldPaymentHash }),
  })
  const mismatchStored = await getOrder(mismatchOrderId)
  assert(mismatch.status === 400 && mismatchStored?.state === 'PAYMENT_MISMATCH', 'A wrong payment reference was not rejected and stored.')
  console.log('wrong references: pass')

  const duplicateFirst = await directOrder()
  const duplicateSecond = await directOrder()
  const duplicateHash = 'aa'.repeat(32)
  await confirmNimPayment({ orderId: duplicateFirst.id, txHash: duplicateHash, blockNumber: 1, confirmations: 1 })
  let duplicateRejected = false
  try {
    await confirmNimPayment({ orderId: duplicateSecond.id, txHash: duplicateHash, blockNumber: 1, confirmations: 1 })
  } catch (error) {
    duplicateRejected = error instanceof DuplicateNimPaymentError
  }
  assert(duplicateRejected, 'A NIM payment hash was reusable across orders.')
  console.log('duplicate NIM payments: pass')

  const expired = await directOrder()
  await confirmNimPayment({ orderId: expired.id, txHash: 'bb'.repeat(32), blockNumber: 2, confirmations: 1 })
  await pool.query("UPDATE orders SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [expired.id])
  const expiredRelay = await request('/v1/relay/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: expired.id }),
  })
  const expiredStored = await getOrder(expired.id)
  assert(expiredRelay.status === 400 && expiredStored?.state === 'PAYMENT_EXPIRED', 'An expired paid order was not closed before relay.')
  console.log('expired orders: pass')

  const replay = await directOrder()
  await confirmNimPayment({ orderId: replay.id, txHash: 'cc'.repeat(32), blockNumber: 3, confirmations: 1 })
  const replayAuthorization = authorization(replay.id, '11')
  const firstReservation = await reserveRelayAttempt(replay.id, replayAuthorization)
  const secondReservation = await reserveRelayAttempt(replay.id, replayAuthorization)
  assert(firstReservation.created && !secondReservation.created, 'A relay authorization was reserved more than once.')
  assert(firstReservation.attempt.id === secondReservation.attempt.id, 'Relay replay did not return the original attempt.')
  const persistedHash = `0x${'dd'.repeat(32)}`
  const firstSubmission = await recordRelaySubmission(replay.id, replayAuthorization.authorizationDigest, persistedHash)
  const secondSubmission = await recordRelaySubmission(replay.id, replayAuthorization.authorizationDigest, persistedHash)
  const storedAttempt = await getRelayAttemptByDigest(replayAuthorization.authorizationDigest)
  assert(firstSubmission.attempt.txHash === persistedHash && secondSubmission.attempt.txHash === persistedHash && storedAttempt?.status === 'SUBMITTED', 'The relay hash was not durable or submission replay-safe.')
  await recordRelayOutcome(replay.id, replayAuthorization.authorizationDigest, {
    status: 'SUBMITTED',
    receiptStatus: 'pending',
    error: 'Smoke-test pending receipt.',
  })
  console.log('relay replay, hash persistence, and pending retry: pass')

  await recordRelayOutcome(replay.id, replayAuthorization.authorizationDigest, {
    status: 'RECOVERY_REQUIRED',
    error: 'Smoke-test reservation recovered without a broadcast hash.',
  })
  const recoveredOrder = await getOrder(replay.id)
  assert(recoveredOrder?.state === 'RECOVERY_REQUIRED', 'Recovery-required state was not persisted.')
  console.log('recovery state: pass')
}

try {
  await main()
  console.log('durable smoke: pass')
} finally {
  if (createdOrderIds.length > 0) {
    await pool.query('DELETE FROM relay_attempts WHERE order_id = ANY($1::text[])', [createdOrderIds])
    await pool.query('DELETE FROM orders WHERE id = ANY($1::text[])', [createdOrderIds])
  }
  await pool.end()
}
