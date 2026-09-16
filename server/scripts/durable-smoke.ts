import { config, validateUsdtAmount } from '../src/config.js'
import { initializeDatabase, pool } from '../src/db.js'
import {
  confirmNimPayment,
  confirmRefund,
  createQuote,
  createOrder,
  createOrderFromQuote,
  DuplicateNimPaymentError,
  getRelayAttemptByDigest,
  getRelayAttemptCount,
  getOrder,
  markPaymentMismatch,
  recordRefundFailure,
  recordRelayOutcome,
  recordRelaySubmission,
  requestRefund,
  reserveRelayAttempt,
} from '../src/orders.js'

const apiBaseUrl = process.env.NIMFUEL_TEST_API_BASE_URL?.trim() || 'http://127.0.0.1:3001'
const nimAddress = 'NQ54RXNRPXPH3YXK144CSS31SKBUYYBU6NSJ'
const evmAddress = '0x83975720D8eCE69356dfCfe5a9900D2B850DaF26'
const amountRaw = 100_000n
const oldPaymentHash = '7228593499bc55177ca1deb90359a65367646d5cbc099c63b331ae0838887bb6'
const createdOrderIds: string[] = []
const createdQuoteIds: string[] = []

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  const body = await response.json() as Record<string, unknown>
  return { status: response.status, body }
}

function testUserAddress(seed: string) {
  return `0x${seed.repeat(40).slice(0, 40)}`
}

function authorizationRecord(digestByte: string, userAddress = evmAddress, requestedAmountRaw = amountRaw) {
  return {
    authorizationDigest: `0x${digestByte.repeat(32)}`,
    nonce: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 900),
    userAddress,
    recipient: userAddress,
    amountRaw: requestedAmountRaw,
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

async function createTestQuote(digestByte: string, ttlSeconds = 900, requestedAmountRaw = amountRaw, userAddress = testUserAddress(digestByte)) {
  const quote = await createQuote({
    authorization: authorizationRecord(digestByte, userAddress, requestedAmountRaw),
    polPriceUsdNanos: 100_000_000n,
    nimPriceUsdNanos: 1_000_000n,
    serviceFeeBps: 500,
    serviceFeeLuna: 100n,
    relayCostLuna: 20_000n,
    paymentAmountLuna: 20_100n,
    priceSource: 'smoke-test',
    ttlSeconds,
  })
  createdQuoteIds.push(quote.id)
  return quote
}

async function apiOrder(digestByte: string) {
  const quote = await createTestQuote(digestByte)
  const result = await request('/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nimAddress, quoteId: quote.id }),
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
    ...authorizationRecord(digestByte),
  }
}

async function main() {
  await initializeDatabase()

  const invalidAmount = await request('/v1/preflight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountRaw: '0' }),
  })
  assert(invalidAmount.status === 400, 'An invalid zero amount was accepted.')
  console.log('invalid amounts: pass')

  const flexibleAmountRaw = 1_250_000n
  assert(validateUsdtAmount(flexibleAmountRaw) === flexibleAmountRaw, 'A valid non-proof USDT amount was rejected.')
  const flexibleQuote = await createTestQuote('f1', 900, flexibleAmountRaw)
  const flexibleOrder = await createOrderFromQuote({
    nimAddress,
    paymentRecipient: config.nimRecipient!,
    quoteId: flexibleQuote.id,
  })
  createdOrderIds.push(flexibleOrder.id)
  assert(flexibleOrder.amountRaw === flexibleAmountRaw, 'A flexible USDT amount was not retained in the order.')
  console.log('flexible amount policy and order: pass')

  const nonceUser = testUserAddress('ab')
  const nonceQuote = await createTestQuote('f2', 900, amountRaw, nonceUser)
  const conflictingNonceQuote = await createTestQuote('f3', 900, flexibleAmountRaw, nonceUser)
  const nonceOrder = await createOrderFromQuote({
    nimAddress,
    paymentRecipient: config.nimRecipient!,
    quoteId: nonceQuote.id,
  })
  createdOrderIds.push(nonceOrder.id)
  let nonceConflictRejected = false
  try {
    await createOrderFromQuote({
      nimAddress,
      paymentRecipient: config.nimRecipient!,
      quoteId: conflictingNonceQuote.id,
    })
  } catch (error) {
    nonceConflictRejected = error instanceof Error && error.message.includes('active order for authorization nonce')
  }
  assert(nonceConflictRejected, 'Two active orders were allowed to compete for one wallet nonce.')
  await markPaymentMismatch(nonceOrder.id, 'Smoke-test mismatched payment.')
  let mismatchConflictRejected = false
  try {
    await createOrderFromQuote({
      nimAddress,
      paymentRecipient: config.nimRecipient!,
      quoteId: conflictingNonceQuote.id,
    })
  } catch (error) {
    mismatchConflictRejected = error instanceof Error && error.message.includes('active order for authorization nonce')
  }
  assert(mismatchConflictRejected, 'A mismatched payment order was allowed to release its wallet nonce.')
  console.log('nonce conflict guard: pass')

  const quoteOrder = await createTestQuote('e1')
  const quoteCreated = await createOrderFromQuote({
    nimAddress,
    paymentRecipient: config.nimRecipient!,
    quoteId: quoteOrder.id,
  })
  createdOrderIds.push(quoteCreated.id)
  let quoteReuseRejected = false
  try {
    await createOrderFromQuote({
      nimAddress,
      paymentRecipient: config.nimRecipient!,
      quoteId: quoteOrder.id,
    })
  } catch {
    quoteReuseRejected = true
  }
  assert(quoteReuseRejected, 'A consumed quote was reused.')
  const expiredQuote = await createTestQuote('e2', -1)
  let expiredQuoteRejected = false
  try {
    await createOrderFromQuote({
      nimAddress,
      paymentRecipient: config.nimRecipient!,
      quoteId: expiredQuote.id,
    })
  } catch {
    expiredQuoteRejected = true
  }
  assert(expiredQuoteRejected, 'An expired quote created an order.')
  console.log('quote consumption and expiry: pass')

  const unpaidOrderId = await apiOrder('a1')
  const unpaidRelay = await request('/v1/relay/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: unpaidOrderId }),
  })
  assert(unpaidRelay.status === 400, 'An unpaid order reached relay execution.')
  console.log('unpaid relay gate: pass')

  const adminWithoutAuth = await request(`/v1/admin/orders?orderId=${encodeURIComponent(unpaidOrderId)}`)
  const adminToken = process.env.ADMIN_API_TOKEN?.trim()
  assert(adminWithoutAuth.status === (adminToken ? 401 : 503), 'The admin lookup authorization gate returned an unexpected status.')
  if (adminToken) {
    const adminLookup = await request(`/v1/admin/orders?orderId=${encodeURIComponent(unpaidOrderId)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(adminLookup.status === 200
      && typeof adminLookup.body.order === 'object'
      && Array.isArray(adminLookup.body.relayAttempts), 'Authorized admin lookup did not return the order snapshot.')
  }
  console.log('admin lookup authorization: pass')

  const mismatchOrderId = await apiOrder('a2')
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

  assert(await getRelayAttemptCount(replay.id) === 1, 'Relay attempt count was not scoped to the order.')
  const refundPending = await requestRefund(replay.id)
  assert(refundPending.state === 'REFUND_PENDING'
    && refundPending.refundRecipient === nimAddress
    && refundPending.refundAmountLuna !== undefined, 'Refund pending state was not persisted.')
  const refundError = await recordRefundFailure(replay.id, 'Smoke-test refund mismatch.')
  assert(refundError?.state === 'REFUND_PENDING' && refundError.refundLastError === 'Smoke-test refund mismatch.', 'Refund failure was not retained.')
  let relayAfterRefundRejected = false
  try {
    await recordRelayOutcome(replay.id, replayAuthorization.authorizationDigest, {
      status: 'CONFIRMED',
      receiptStatus: 'success',
      blockNumber: 4n,
      gasUsed: 70_000n,
      transferVerified: true,
      nonceAdvanced: true,
    })
  } catch {
    relayAfterRefundRejected = true
  }
  assert(relayAfterRefundRejected, 'A relay outcome changed an order after refund processing started.')
  const refunded = await confirmRefund({
    orderId: replay.id,
    txHash: `0x${'ee'.repeat(32)}`,
    blockNumber: 5,
    confirmations: 1,
  })
  assert(refunded.state === 'REFUNDED' && refunded.refundTxHash === `0x${'ee'.repeat(32)}`, 'Refunded state was not persisted.')
  let secondRefundRejected = false
  try {
    await requestRefund(replay.id)
  } catch {
    secondRefundRejected = true
  }
  assert(secondRefundRejected, 'A refunded order accepted a second refund request.')
  console.log('refund state, verification record, and post-refund relay guard: pass')

  const capped = await directOrder()
  await confirmNimPayment({ orderId: capped.id, txHash: 'ff'.repeat(32), blockNumber: 6, confirmations: 1 })
  for (let index = 0; index < config.relayMaxAttempts; index += 1) {
    const byte = (0x30 + index).toString(16).padStart(2, '0')
    const attemptAuthorization = authorization(capped.id, byte)
    await reserveRelayAttempt(capped.id, attemptAuthorization)
    await recordRelayOutcome(capped.id, attemptAuthorization.authorizationDigest, {
      status: 'FAILED',
      error: `Smoke-test failed relay attempt ${index + 1}.`,
    })
  }
  let retryLimitRejected = false
  try {
    await reserveRelayAttempt(capped.id, authorization(capped.id, '40'))
  } catch (error) {
    retryLimitRejected = true
  }
  const cappedStored = await getOrder(capped.id)
  assert(retryLimitRejected && cappedStored?.state === 'RECOVERY_REQUIRED', 'The relay retry limit did not enter recovery.')
  console.log('per-order retry limit: pass')
}

try {
  await main()
  console.log('durable smoke: pass')
} finally {
  if (createdOrderIds.length > 0) {
    await pool.query('DELETE FROM relay_attempts WHERE order_id = ANY($1::text[])', [createdOrderIds])
  }
  if (createdQuoteIds.length > 0) {
    await pool.query('DELETE FROM quotes WHERE id = ANY($1::text[])', [createdQuoteIds])
  }
  if (createdOrderIds.length > 0) {
    await pool.query('DELETE FROM orders WHERE id = ANY($1::text[])', [createdOrderIds])
  }
  await pool.end()
}
