import { createPublicClient, createWalletClient, formatUnits, http, parseEventLogs, verifyTypedData, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { databaseHealth, initializeDatabase, closeDatabase } from './db.js'
import { armLiveBroadcastWindow, config, isLiveBroadcastEnabled, polygon, POLYGON_CHAIN_ID, POLYGON_USDT_ADDRESS, requireAddress, requireRawAmount, requireUnsignedInteger } from './config.js'
import {
  confirmNimPayment,
  createOrder,
  getOrder,
  getOutstandingRelayAttempts,
  getRelayAttemptByDigest,
  markPaymentExpired,
  markPaymentMismatch,
  publicOrder,
  recordRelayOutcome,
  recordRelaySubmission,
  reserveRelayAttempt,
  type NimfuelOrder,
  type RelayAttempt,
  type RelayAuthorizationRecord,
} from './orders.js'
import { normalizeNimAddress, normalizeNimTransactionHash, parseNimInteger, readNimiqAccount, readNimiqTransaction, requireNimAddress } from './nim.js'
import { encodeMetaTransaction, encodeTransfer, metaTransactionDigest, metaTransactionDomain, metaTransactionTypes, tokenAbi } from './relay.js'

const publicClient = createPublicClient({ chain: polygon, transport: http(config.polygonRpcUrl) })
const relayerAccount = config.relayerPrivateKey ? privateKeyToAccount(config.relayerPrivateKey) : null
const walletClient = relayerAccount
  ? createWalletClient({ account: relayerAccount, chain: polygon, transport: http(config.polygonRpcUrl) })
  : null

const allowedOrigin = '*'
const LIVE_RELAY_MAX_AMOUNT_RAW = 100_000n
const inFlightRelays = new Map<string, Promise<unknown>>()
const recoveryInFlight = new Set<string>()

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed.'
}

async function readJson(request: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }

  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  const body = JSON.parse(text) as unknown
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object.')
  }
  return body as Record<string, unknown>
}

async function readCapability() {
  const [chainId, name, version, domainSeparator] = await Promise.all([
    publicClient.readContract({ address: POLYGON_USDT_ADDRESS, abi: tokenAbi, functionName: 'getChainId' }),
    publicClient.readContract({ address: POLYGON_USDT_ADDRESS, abi: tokenAbi, functionName: 'name' }),
    publicClient.readContract({ address: POLYGON_USDT_ADDRESS, abi: tokenAbi, functionName: 'ERC712_VERSION' }),
    publicClient.readContract({ address: POLYGON_USDT_ADDRESS, abi: tokenAbi, functionName: 'getDomainSeperator' }),
  ])

  return {
    chainId: Number(chainId),
    tokenAddress: POLYGON_USDT_ADDRESS,
    tokenName: name,
    eip712Version: version,
    domainSeparator,
    nativeMetaTransaction: true,
    relayerConfigured: Boolean(relayerAccount),
    relayerAddress: relayerAccount?.address ?? null,
    liveBroadcastEnabled: isLiveBroadcastEnabled(),
    liveRelayMaxAttempts: config.liveRelayMaxAttempts,
    orderStorage: 'postgres',
  }
}

async function prepareRelay(body: Record<string, unknown>) {
  const userAddress = requireAddress(body.userAddress, 'userAddress')
  const recipient = requireAddress(body.recipient, 'recipient')
  const amountRaw = requireRawAmount(body.amountRaw)
  const nonce = requireUnsignedInteger(body.nonce, 'nonce')
  const deadline = requireUnsignedInteger(body.deadline, 'deadline')
  const functionSignature = body.functionSignature
  const signature = body.signature

  if (typeof functionSignature !== 'string' || !/^0x[0-9a-f]*$/i.test(functionSignature)) {
    throw new Error('functionSignature must be hex data.')
  }
  if (typeof signature !== 'string') throw new Error('signature is required.')

  const expectedFunctionSignature = encodeTransfer(recipient, amountRaw)
  if (functionSignature.toLowerCase() !== expectedFunctionSignature.toLowerCase()) {
    throw new Error('The signed function does not match the requested USDT transfer.')
  }

  const now = BigInt(Math.floor(Date.now() / 1000))
  if (deadline <= now) throw new Error('Authorization deadline has expired.')

  const [currentNonce, userBalance, decimals] = await Promise.all([
    publicClient.readContract({
      address: POLYGON_USDT_ADDRESS,
      abi: tokenAbi,
      functionName: 'getNonce',
      args: [userAddress],
    }),
    publicClient.readContract({
      address: POLYGON_USDT_ADDRESS,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [userAddress],
    }),
    publicClient.readContract({ address: POLYGON_USDT_ADDRESS, abi: tokenAbi, functionName: 'decimals' }),
  ])

  if (currentNonce !== nonce) {
    throw new Error(`Authorization nonce is stale. Expected ${currentNonce.toString()}.`)
  }
  if (amountRaw > userBalance) throw new Error('User USDT balance is too low for this transfer.')

  const validSignature = await verifyTypedData({
    address: userAddress,
    domain: metaTransactionDomain(),
    types: metaTransactionTypes,
    primaryType: 'MetaTransaction',
    message: { nonce, from: userAddress, functionSignature: functionSignature as Hex },
    signature: signature as Hex,
  })
  if (!validSignature) throw new Error('EIP-712 authorization does not match the user address.')

  if (!relayerAccount) throw new Error('Relayer private key is not configured with a valid format.')

  const executeData = encodeMetaTransaction(userAddress, functionSignature as Hex, signature)
  const gasEstimate = await publicClient.estimateGas({
    account: relayerAccount.address,
    to: POLYGON_USDT_ADDRESS,
    data: executeData,
  })
  const [relayerBalance, gasPrice, chainId] = await Promise.all([
    publicClient.getBalance({ address: relayerAccount.address }),
    publicClient.getGasPrice(),
    publicClient.getChainId(),
  ])
  const estimatedFeeRaw = gasEstimate * gasPrice
  if (relayerBalance < estimatedFeeRaw) {
    throw new Error('Relayer POL balance is below the estimated transaction fee.')
  }

  return {
    chainId,
    tokenAddress: POLYGON_USDT_ADDRESS,
    userAddress,
    recipient,
    amountRaw,
    amount: formatUnits(amountRaw, Number(decimals)),
    nonce,
    deadline,
    authorizationDigest: metaTransactionDigest(userAddress, nonce, functionSignature as Hex),
    gasEstimate,
    gasPrice,
    estimatedFeeRaw,
    relayerAddress: relayerAccount.address,
    relayerBalanceRaw: relayerBalance,
    decimals: Number(decimals),
    functionSignature: functionSignature as Hex,
    signature: signature as Hex,
    executeData,
  }
}

function relayResponse(prepared: Awaited<ReturnType<typeof prepareRelay>>) {
  return {
    valid: true,
    broadcasted: false,
    chainId: prepared.chainId,
    tokenAddress: prepared.tokenAddress,
    userAddress: prepared.userAddress,
    recipient: prepared.recipient,
    amountRaw: prepared.amountRaw.toString(),
    amount: prepared.amount,
    nonce: prepared.nonce.toString(),
    deadline: prepared.deadline.toString(),
    authorizationDigest: prepared.authorizationDigest,
    gasEstimate: prepared.gasEstimate.toString(),
    gasPrice: prepared.gasPrice.toString(),
    estimatedFeeRaw: prepared.estimatedFeeRaw.toString(),
    relayerAddress: prepared.relayerAddress,
    relayerBalance: formatUnits(prepared.relayerBalanceRaw, 18),
  }
}

async function validateRelay(body: Record<string, unknown>) {
  return relayResponse(await prepareRelay(body))
}

async function orderForId(orderId: string) {
  const order = await getOrder(orderId)
  if (!order) throw new Error('Order was not found.')
  return order
}

function normalizeHexData(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/^0x/i, '').toLowerCase() : ''
}

async function nimTransactionSenderMatchesOrder(transaction: Awaited<ReturnType<typeof readNimiqTransaction>>, expectedSender: string) {
  const from = typeof transaction.from === 'string' ? normalizeNimAddress(transaction.from) : ''
  if (from === expectedSender) return true
  if (!from || !config.nimVerificationEndpoint) return false

  const senderAccount = await readNimiqAccount(config.nimVerificationEndpoint, from)
  const accountType = typeof senderAccount.type === 'string' ? senderAccount.type.trim().toLowerCase() : ''
  const htlcSender = typeof senderAccount.sender === 'string'
    ? normalizeNimAddress(senderAccount.sender)
    : ''

  return accountType === 'htlc' && htlcSender === expectedSender
}

async function createNimOrder(body: Record<string, unknown>) {
  if (!config.nimRecipient) throw new Error('NIM payment recipient is not configured.')
  if (!config.nimPaymentAmountLuna) throw new Error('NIM payment amount is not configured.')

  const nimAddress = requireNimAddress(body.nimAddress, 'nimAddress')
  const paymentRecipient = requireNimAddress(config.nimRecipient, 'NIM payment recipient')
  const evmAddress = requireAddress(body.evmAddress, 'evmAddress')
  const recipient = requireAddress(body.recipient, 'recipient')
  const amountRaw = requireRawAmount(body.amountRaw)

  return publicOrder(await createOrder({
    nimAddress,
    paymentRecipient,
    paymentAmountLuna: config.nimPaymentAmountLuna,
    evmAddress,
    recipient,
    amountRaw,
    ttlSeconds: 15 * 60,
  }))
}

async function verifyNimPayment(orderId: string, body: Record<string, unknown>) {
  const order = await orderForId(orderId)
  const txHash = normalizeNimTransactionHash(body.txHash)

  if (order.paymentTxHash) {
    if (order.paymentTxHash === txHash) return publicOrder(order)
    throw new Error('This order already has a different payment transaction.')
  }

  if (Date.now() >= order.expiresAt) {
    await markPaymentExpired(orderId, 'The order expired before payment verification.')
    throw new Error('This NIM payment order has expired.')
  }
  if (!config.nimVerificationEndpoint) throw new Error('NIM verification endpoint is not configured.')

  const transaction = await readNimiqTransaction(config.nimVerificationEndpoint, txHash)
  const transactionHash = typeof transaction.hash === 'string'
    ? normalizeNimTransactionHash(transaction.hash)
    : txHash
  const blockNumber = parseNimInteger(transaction.blockNumber, 'Nimiq block number')
  const confirmations = transaction.confirmations === undefined
    ? 0n
    : parseNimInteger(transaction.confirmations, 'Nimiq confirmations')
  const value = parseNimInteger(transaction.value, 'Nimiq transaction value')
  const to = typeof transaction.to === 'string' ? normalizeNimAddress(transaction.to) : ''
  const recipientData = normalizeHexData(transaction.recipientData)
  const expectedRecipient = normalizeNimAddress(order.paymentRecipient)
  const expectedData = order.expectedPaymentDataHex.toLowerCase()
  const senderMatchesOrder = await nimTransactionSenderMatchesOrder(transaction, order.nimAddress)

  const matchesOrder = transactionHash === txHash
    && transaction.executionResult === true
    && blockNumber > 0n
    && confirmations >= 1n
    && senderMatchesOrder
    && to === expectedRecipient
    && value === order.paymentAmountLuna
    && recipientData === expectedData

  if (!matchesOrder) {
    await markPaymentMismatch(orderId, 'The NIM transaction did not match the order sender, recipient, amount, reference, or confirmation state.')
    throw new Error('NIM payment did not match this order.')
  }

  if (!Number.isSafeInteger(Number(blockNumber))) throw new Error('Nimiq block number is outside the supported range.')
  if (!Number.isSafeInteger(Number(confirmations))) throw new Error('Nimiq confirmations are outside the supported range.')

  return publicOrder(await confirmNimPayment({
    orderId,
    txHash,
    blockNumber: Number(blockNumber),
    confirmations: Number(confirmations),
  }))
}

const RELAY_RECEIPT_TIMEOUT_MS = 30_000

function requestedAuthorizationDigest(body: Record<string, unknown>) {
  try {
    const userAddress = requireAddress(body.userAddress, 'userAddress')
    const nonce = requireUnsignedInteger(body.nonce, 'nonce')
    const functionSignature = body.functionSignature
    if (typeof functionSignature !== 'string' || !/^0x[0-9a-f]*$/i.test(functionSignature)) return null
    return metaTransactionDigest(userAddress, nonce, functionSignature as Hex)
  } catch {
    return null
  }
}

function relayResponseFromAttempt(attempt: RelayAttempt) {
  return {
    valid: true,
    broadcasted: Boolean(attempt.txHash),
    chainId: POLYGON_CHAIN_ID,
    tokenAddress: POLYGON_USDT_ADDRESS,
    userAddress: attempt.userAddress,
    recipient: attempt.recipient,
    amountRaw: attempt.amountRaw.toString(),
    amount: formatUnits(attempt.amountRaw, attempt.decimals),
    nonce: attempt.nonce.toString(),
    deadline: attempt.deadline.toString(),
    authorizationDigest: attempt.authorizationDigest,
    gasEstimate: attempt.gasEstimate.toString(),
    gasPrice: attempt.gasPrice.toString(),
    estimatedFeeRaw: attempt.estimatedFeeRaw.toString(),
    relayerAddress: attempt.relayerAddress,
    txHash: attempt.txHash,
    receiptStatus: attempt.receiptStatus,
    blockNumber: attempt.blockNumber?.toString(),
    gasUsed: attempt.gasUsed?.toString(),
    transferVerified: attempt.transferVerified,
    nonceAdvanced: attempt.nonceAdvanced,
    verifiedStateChange: attempt.status === 'CONFIRMED',
    error: attempt.lastError,
  }
}

function authorizationRecord(orderId: string, prepared: Awaited<ReturnType<typeof prepareRelay>>): RelayAuthorizationRecord {
  return {
    orderId,
    authorizationDigest: prepared.authorizationDigest,
    nonce: prepared.nonce,
    deadline: prepared.deadline,
    userAddress: prepared.userAddress,
    recipient: prepared.recipient,
    amountRaw: prepared.amountRaw,
    decimals: prepared.decimals,
    functionSignature: prepared.functionSignature,
    signature: prepared.signature,
    executeData: prepared.executeData,
    gasEstimate: prepared.gasEstimate,
    gasPrice: prepared.gasPrice,
    estimatedFeeRaw: prepared.estimatedFeeRaw,
    relayerAddress: prepared.relayerAddress,
  }
}

async function waitForRelayReceipt(txHash: Hex) {
  try {
    return {
      receipt: await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RELAY_RECEIPT_TIMEOUT_MS }),
      error: null,
    }
  } catch (error) {
    return { receipt: null, error: errorMessage(error) }
  }
}

async function verifyRelayReceipt(attempt: RelayAttempt, receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>) {
  const nonceAfter = await publicClient.readContract({
    address: POLYGON_USDT_ADDRESS,
    abi: tokenAbi,
    functionName: 'getNonce',
    args: [requireAddress(attempt.userAddress, 'relay user address')],
  })
  const transferEvents = parseEventLogs({
    abi: tokenAbi,
    eventName: 'Transfer',
    logs: receipt.logs,
    strict: false,
  })
  const transferVerified = transferEvents.some(event => {
    const args = event.args as { from?: string; to?: string; value?: bigint }
    return args.from?.toLowerCase() === attempt.userAddress.toLowerCase()
      && args.to?.toLowerCase() === attempt.recipient.toLowerCase()
      && args.value === attempt.amountRaw
  })
  const nonceAdvanced = nonceAfter >= attempt.nonce + 1n
  return { transferVerified, nonceAdvanced }
}

async function reconcileRelayAttempt(orderId: string, attempt: RelayAttempt) {
  if (attempt.orderId !== orderId) throw new Error('This relay authorization belongs to another order.')

  if (attempt.status === 'CONFIRMED' || attempt.status === 'FAILED') {
    const order = await orderForId(orderId)
    return { ...relayResponseFromAttempt(attempt), order: publicOrder(order) }
  }
  if (attempt.status === 'RECOVERY_REQUIRED') {
    throw new Error(attempt.lastError || 'This relay requires manual recovery before another broadcast.')
  }
  if (!attempt.txHash) {
    const updated = await recordRelayOutcome(orderId, attempt.authorizationDigest, {
      status: 'RECOVERY_REQUIRED',
      error: 'The relay reservation has no transaction hash. Manual recovery is required before retrying.',
    })
    throw new Error(updated.attempt.lastError || 'This relay requires manual recovery before another broadcast.')
  }

  const { receipt, error } = await waitForRelayReceipt(attempt.txHash as Hex)
  if (!receipt) {
    const updated = await recordRelayOutcome(orderId, attempt.authorizationDigest, {
      status: 'SUBMITTED',
      receiptStatus: 'pending',
      error: `Polygon receipt is still pending. ${error || 'Retry reconciliation after the transaction is included.'}`,
    })
    return { ...relayResponseFromAttempt(updated.attempt), order: publicOrder(updated.order) }
  }

  if (receipt.status === 'reverted') {
    const updated = await recordRelayOutcome(orderId, attempt.authorizationDigest, {
      status: 'FAILED',
      receiptStatus: receipt.status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      error: 'The Polygon transaction reverted. A new authorization is required for a retry.',
    })
    return { ...relayResponseFromAttempt(updated.attempt), order: publicOrder(updated.order) }
  }

  const verification = await verifyRelayReceipt(attempt, receipt)
  const updated = await recordRelayOutcome(orderId, attempt.authorizationDigest, {
    status: verification.transferVerified && verification.nonceAdvanced ? 'CONFIRMED' : 'RECOVERY_REQUIRED',
    receiptStatus: receipt.status,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    transferVerified: verification.transferVerified,
    nonceAdvanced: verification.nonceAdvanced,
    error: verification.transferVerified && verification.nonceAdvanced
      ? null
      : 'The Polygon receipt succeeded but the intended USDT transfer or nonce change could not be verified. Manual recovery is required.',
  })
  if (updated.attempt.status === 'RECOVERY_REQUIRED') {
    throw new Error(updated.attempt.lastError || 'The relay requires manual recovery.')
  }
  return { ...relayResponseFromAttempt(updated.attempt), order: publicOrder(updated.order) }
}

async function markRelayRecovery(orderId: string, authorizationDigest: string, message: string) {
  try {
    return await recordRelayOutcome(orderId, authorizationDigest, {
      status: 'RECOVERY_REQUIRED',
      error: message,
    })
  } catch {
    return null
  }
}

async function executeNewRelay(orderId: string, prepared: Awaited<ReturnType<typeof prepareRelay>>) {
  if (!isLiveBroadcastEnabled()) throw new Error('Live broadcast is disabled.')
  if (!relayerAccount || !walletClient) throw new Error('Relayer private key is not configured with a valid format.')
  if (prepared.amountRaw !== LIVE_RELAY_MAX_AMOUNT_RAW) {
    throw new Error('The first live relay is limited to exactly 0.1 USDT.')
  }

  const reservation = await reserveRelayAttempt(orderId, authorizationRecord(orderId, prepared))
  if (!reservation.created) return await reconcileRelayAttempt(orderId, reservation.attempt)

  let transactionHash: Hex
  try {
    transactionHash = await walletClient.sendTransaction({
      account: relayerAccount,
      chain: polygon,
      to: POLYGON_USDT_ADDRESS,
      data: prepared.executeData,
      value: 0n,
      gas: prepared.gasEstimate,
    })
  } catch (error) {
    await markRelayRecovery(orderId, prepared.authorizationDigest, 'The relayer request ended without a transaction hash. Manual recovery is required before retrying.')
    throw new Error(`The relayer request did not return a transaction hash. ${errorMessage(error)}`)
  }

  let submitted: Awaited<ReturnType<typeof recordRelaySubmission>>
  try {
    submitted = await recordRelaySubmission(orderId, prepared.authorizationDigest, transactionHash)
  } catch (error) {
    await markRelayRecovery(orderId, prepared.authorizationDigest, 'A Polygon transaction was submitted, but its hash could not be persisted. Manual recovery is required.')
    throw new Error(`The Polygon transaction was submitted, but durable relay state could not be saved. ${errorMessage(error)}`)
  }

  return await reconcileRelayAttempt(orderId, submitted.attempt)
}

async function executeOrderRelay(orderId: string, body: Record<string, unknown>) {
  const order = await orderForId(orderId)

  if (order.state === 'FULFILLED') {
    const attempt = order.relayAuthorizationDigest
      ? await getRelayAttemptByDigest(order.relayAuthorizationDigest)
      : null
    return attempt
      ? await reconcileRelayAttempt(orderId, attempt)
      : { valid: true, broadcasted: true, verifiedStateChange: true, order: publicOrder(order) }
  }

  const requestedDigest = requestedAuthorizationDigest(body)
  if (requestedDigest) {
    const existing = await getRelayAttemptByDigest(requestedDigest)
    if (existing) return await reconcileRelayAttempt(orderId, existing)
  }

  if (['RELAY_BROADCASTING', 'RELAY_SUBMITTED'].includes(order.state)) {
    const existing = order.relayAuthorizationDigest
      ? await getRelayAttemptByDigest(order.relayAuthorizationDigest)
      : null
    if (existing) return await reconcileRelayAttempt(orderId, existing)
    throw new Error('This order already has a relay attempt that requires reconciliation. Retry with the same signed authorization.')
  }
  if (order.state === 'RECOVERY_REQUIRED') {
    throw new Error('This order requires manual relay recovery before another broadcast.')
  }
  if (!['NIM_PAYMENT_CONFIRMED', 'RELAY_FAILED'].includes(order.state)) {
    throw new Error('The NIM payment must be independently confirmed before relay execution.')
  }
  if (Date.now() >= order.expiresAt) {
    await markPaymentExpired(orderId, 'The order expired before Polygon fulfillment.')
    throw new Error('This NIM payment order has expired before relay execution.')
  }
  if (!isLiveBroadcastEnabled()) throw new Error('Live broadcast is disabled.')

  const prepared = await prepareRelay(body)
  if (prepared.userAddress.toLowerCase() !== order.evmAddress.toLowerCase()) {
    throw new Error('The relay authorization user does not match the paid order.')
  }
  if (prepared.recipient.toLowerCase() !== order.recipient.toLowerCase()) {
    throw new Error('The relay recipient does not match the paid order.')
  }
  if (prepared.amountRaw !== order.amountRaw) {
    throw new Error('The relay amount does not match the paid order.')
  }

  const executionKey = `order:${order.id}:${prepared.authorizationDigest}`
  const existing = inFlightRelays.get(executionKey)
  if (existing) return existing

  const execution = executeNewRelay(orderId, prepared)
  inFlightRelays.set(executionKey, execution)
  try {
    return await execution
  } finally {
    inFlightRelays.delete(executionKey)
  }
}

async function executeRelay(body: Record<string, unknown>) {
  if (typeof body.orderId !== 'string' || !body.orderId.trim()) {
    throw new Error('orderId is required for live relay execution.')
  }
  return await executeOrderRelay(body.orderId.trim(), body)
}

async function recoverOutstandingRelayAttempts() {
  const attempts = await getOutstandingRelayAttempts()
  for (const attempt of attempts) {
    if (recoveryInFlight.has(attempt.authorizationDigest)) continue
    recoveryInFlight.add(attempt.authorizationDigest)
    try {
      if (attempt.status === 'BROADCASTING' && !attempt.txHash) {
        await recordRelayOutcome(attempt.orderId, attempt.authorizationDigest, {
          status: 'RECOVERY_REQUIRED',
          error: 'The server recovered a relay reservation without a transaction hash. Manual recovery is required.',
        })
      } else {
        await reconcileRelayAttempt(attempt.orderId, attempt)
      }
    } catch (error) {
      console.error(`Relay recovery needs attention for order ${attempt.orderId}: ${errorMessage(error)}`)
    } finally {
      recoveryInFlight.delete(attempt.authorizationDigest)
    }
  }
}

const server = (await import('node:http')).createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {})
    return
  }

  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      await databaseHealth()
      sendJson(response, 200, {
        ok: true,
        service: 'nimfuel-server',
        chainId: POLYGON_CHAIN_ID,
        tokenAddress: POLYGON_USDT_ADDRESS,
        relayerConfigured: Boolean(relayerAccount),
        nimRecipientConfigured: Boolean(config.nimRecipient),
        nimVerificationConfigured: Boolean(config.nimVerificationEndpoint),
        nimVerificationApiKeyConfigured: config.nimVerificationApiKeyConfigured,
        nimPaymentConfigured: Boolean(config.nimPaymentAmountLuna),
        orderStorage: 'postgres',
        priceApiConfigured: Boolean(config.priceApiUrl),
        priceApiKeyConfigured: config.priceApiKeyConfigured,
        databaseConfigured: config.databaseConfigured,
        liveBroadcastEnabled: isLiveBroadcastEnabled(),
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/v1/relay/capability') {
      sendJson(response, 200, await readCapability())
      return
    }

    if (request.method === 'POST' && url.pathname === '/v1/relay/validate') {
      sendJson(response, 200, await validateRelay(await readJson(request)))
      return
    }

    if (request.method === 'POST' && url.pathname === '/v1/relay/execute') {
      sendJson(response, 200, await executeRelay(await readJson(request)))
      return
    }

    if (request.method === 'POST' && url.pathname === '/v1/orders') {
      sendJson(response, 201, await createNimOrder(await readJson(request)))
      return
    }

    const orderMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)$/)
    if (request.method === 'GET' && orderMatch) {
      sendJson(response, 200, publicOrder(await orderForId(decodeURIComponent(orderMatch[1]))))
      return
    }

    const paymentMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)\/verify-payment$/)
    if (request.method === 'POST' && paymentMatch) {
      sendJson(response, 200, await verifyNimPayment(decodeURIComponent(paymentMatch[1]), await readJson(request)))
      return
    }

    sendJson(response, 404, { error: 'Not found.' })
  } catch (error) {
    sendJson(response, 400, { error: errorMessage(error) })
  }
})

await initializeDatabase()

const recoveryTimer = setInterval(() => {
  void recoverOutstandingRelayAttempts().catch(error => {
    console.error(`Relay recovery scan failed: ${errorMessage(error)}`)
  })
}, 30_000)
recoveryTimer.unref()

const shutdown = () => {
  clearInterval(recoveryTimer)
  server.close(() => {
    void closeDatabase().finally(() => process.exit(0))
  })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

server.listen(config.port, config.host, () => {
  armLiveBroadcastWindow()
  console.log(`NimFuel server listening on ${config.host}:${config.port}`)
  void recoverOutstandingRelayAttempts().catch(error => {
    console.error(`Initial relay recovery scan failed: ${errorMessage(error)}`)
  })
})
