import { createPublicClient, createWalletClient, formatUnits, http, parseEventLogs, verifyTypedData, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { timingSafeEqual } from 'node:crypto'
import { databaseHealth, initializeDatabase, closeDatabase } from './db.js'
import { armLiveBroadcastWindow, config, formatUsdtAmount, isLiveBroadcastEnabled, polygon, POLYGON_CHAIN_ID, POLYGON_USDT_ADDRESS, requireAddress, requireRawAmount, requireUnsignedInteger, USDT_DECIMALS, usdtAmountPolicy, validateUsdtAmount } from './config.js'
import {
  confirmRefund,
  confirmNimPayment,
  createOrderFromQuote,
  createQuote,
  getQuoteById,
  getOrderByReference,
  getOrder,
  getOutstandingRelayAttempts,
  getRelayAttemptsByOrderId,
  getRelayAttemptCount,
  getRelayAttemptByDigest,
  markPaymentExpired,
  markPaymentMismatch,
  publicOrder,
  publicQuote,
  recordRefundFailure,
  recordRelayOutcome,
  recordRelaySubmission,
  requestRefund,
  reserveRelayAttempt,
  type NimfuelOrder,
  type RelayAttempt,
  type RelayAuthorizationRecord,
} from './orders.js'
import { encodeNimReference, formatNimAddress, normalizeNimAddress, normalizeNimTransactionHash, parseNimInteger, readNimiqAccount, readNimiqTransaction, requireNimAddress } from './nim.js'
import { calculateNimQuote, formatUsdNanos, readMarketPrices } from './prices.js'
import { encodeMetaTransaction, encodeTransfer, metaTransactionDigest, metaTransactionDomain, metaTransactionTypes, tokenAbi } from './relay.js'

const publicClient = createPublicClient({ chain: polygon, transport: http(config.polygonRpcUrl) })
const relayerAccount = config.relayerPrivateKey ? privateKeyToAccount(config.relayerPrivateKey) : null
const walletClient = relayerAccount
  ? createWalletClient({ account: relayerAccount, chain: polygon, transport: http(config.polygonRpcUrl) })
  : null

const allowedOrigin = '*'
const inFlightRelays = new Map<string, Promise<unknown>>()
const recoveryInFlight = new Set<string>()

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed.'
}

function requireAdmin(request: import('node:http').IncomingMessage) {
  if (!config.adminApiToken) throw new HttpError(503, 'Admin API is not configured.')

  const authorization = request.headers.authorization
  const prefix = 'Bearer '
  if (!authorization?.startsWith(prefix)) throw new HttpError(401, 'Admin authorization is required.')

  const supplied = Buffer.from(authorization.slice(prefix.length), 'utf8')
  const expected = Buffer.from(config.adminApiToken, 'utf8')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new HttpError(401, 'Admin authorization is invalid.')
  }
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
    relayMaxAttempts: config.relayMaxAttempts,
    amountPolicy: usdtAmountPolicy(),
    orderStorage: 'postgres',
  }
}

type RelayPreparationInput = {
  userAddress: unknown
  recipient: unknown
  amountRaw: unknown
  nonce: unknown
  deadline: unknown
  functionSignature: unknown
  signature: unknown
}

function enforceLiveProofAmount(amountRaw: bigint) {
  if (isLiveBroadcastEnabled()
    && config.liveProofAmountRaw !== null
    && amountRaw !== config.liveProofAmountRaw) {
    throw new Error(`The controlled live proof accepts exactly ${formatUsdtAmount(config.liveProofAmountRaw)} USDT.`)
  }
}

async function prepareRelayAuthorization(input: RelayPreparationInput) {
  const userAddress = requireAddress(input.userAddress, 'userAddress')
  const recipient = requireAddress(input.recipient, 'recipient')
  const amountRaw = typeof input.amountRaw === 'bigint' ? input.amountRaw : requireRawAmount(input.amountRaw)
  validateUsdtAmount(amountRaw)
  const nonce = typeof input.nonce === 'bigint' ? input.nonce : requireUnsignedInteger(input.nonce, 'nonce')
  const deadline = typeof input.deadline === 'bigint' ? input.deadline : requireUnsignedInteger(input.deadline, 'deadline')
  const functionSignature = input.functionSignature
  const signature = input.signature

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

  const [currentNonce, userBalance, decimals, userPolBalance] = await Promise.all([
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
    publicClient.getBalance({ address: userAddress }),
  ])

  if (currentNonce !== nonce) {
    throw new Error(`Authorization nonce is stale. Expected ${currentNonce.toString()}.`)
  }
  if (Number(decimals) !== USDT_DECIMALS) {
    throw new Error(`The configured USDT token returned ${String(decimals)} decimals, expected ${USDT_DECIMALS}.`)
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
  if (chainId !== POLYGON_CHAIN_ID) {
    throw new Error(`Polygon RPC returned chain ${chainId}, expected ${POLYGON_CHAIN_ID}.`)
  }
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
    userUsdtBalanceRaw: userBalance,
    nonce,
    deadline,
    authorizationDigest: metaTransactionDigest(userAddress, nonce, functionSignature as Hex),
    gasEstimate,
    gasPrice,
    estimatedFeeRaw,
    userPolBalanceRaw: userPolBalance,
    relayerAddress: relayerAccount.address,
    relayerBalanceRaw: relayerBalance,
    decimals: Number(decimals),
    functionSignature: functionSignature as Hex,
    signature: signature as Hex,
    executeData,
  }
}

async function prepareRelay(body: Record<string, unknown>) {
  return await prepareRelayAuthorization({
    userAddress: body.userAddress,
    recipient: body.recipient,
    amountRaw: body.amountRaw,
    nonce: body.nonce,
    deadline: body.deadline,
    functionSignature: body.functionSignature,
    signature: body.signature,
  })
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
    estimatedFeePol: formatUnits(prepared.estimatedFeeRaw, 18),
    userPolBalance: formatUnits(prepared.userPolBalanceRaw, 18),
    userCanPayGasDirectly: prepared.userPolBalanceRaw >= prepared.estimatedFeeRaw,
    relayerAddress: prepared.relayerAddress,
    relayerBalance: formatUnits(prepared.relayerBalanceRaw, 18),
  }
}

async function validateRelay(body: Record<string, unknown>) {
  return relayResponse(await prepareRelay(body))
}

async function createPreflight(body: Record<string, unknown>) {
  const prepared = await prepareRelay(body)
  enforceLiveProofAmount(prepared.amountRaw)
  const prices = await readMarketPrices()
  const calculation = calculateNimQuote({
    estimatedFeeRaw: prepared.estimatedFeeRaw,
    polPriceUsdNanos: prices.pol.usdNanos,
    nimPriceUsdNanos: prices.nim.usdNanos,
    serviceFeeBps: config.serviceFeeBps,
    fixedServiceFeeLuna: config.fixedServiceFeeLuna,
    minPaymentLuna: config.minPaymentLuna,
  })
  const priceSource = `coinpaprika:${prices.nim.tickerId},coinpaprika:${prices.pol.tickerId}`
  const quote = await createQuote({
    authorization: {
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
    },
    polPriceUsdNanos: prices.pol.usdNanos,
    nimPriceUsdNanos: prices.nim.usdNanos,
    serviceFeeBps: config.serviceFeeBps,
    serviceFeeLuna: calculation.serviceFeeLuna,
    relayCostLuna: calculation.relayCostLuna,
    paymentAmountLuna: calculation.paymentAmountLuna,
    priceSource,
    ttlSeconds: config.quoteTtlSeconds,
  })

  return {
    ...relayResponse(prepared),
    amountPolicy: usdtAmountPolicy(),
    preflight: {
      userUsdtBalance: formatUnits(prepared.userUsdtBalanceRaw, prepared.decimals),
      userPolBalance: formatUnits(prepared.userPolBalanceRaw, 18),
      relayerPolBalance: formatUnits(prepared.relayerBalanceRaw, 18),
      estimatedFeePol: formatUnits(prepared.estimatedFeeRaw, 18),
      userCanPayGasDirectly: prepared.userPolBalanceRaw >= prepared.estimatedFeeRaw,
      relayerCanPayGas: prepared.relayerBalanceRaw >= prepared.estimatedFeeRaw,
    },
    quote: {
      ...publicQuote(quote),
      relayCostUsd: formatUsdNanos(calculation.estimatedFeeUsdNanos),
      serviceCostUsd: formatUsdNanos(calculation.serviceCostUsdNanos),
      priceRetrievedAt: {
        nim: prices.nim.retrievedAt,
        pol: prices.pol.retrievedAt,
      },
    },
  }
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

  const nimAddress = requireNimAddress(body.nimAddress, 'nimAddress')
  const paymentRecipient = requireNimAddress(config.nimRecipient, 'NIM payment recipient')
  if (typeof body.quoteId !== 'string' || !body.quoteId.trim()) {
    throw new Error('quoteId is required. Prepare a live preflight quote first.')
  }

  return publicOrder(await createOrderFromQuote({
    nimAddress,
    paymentRecipient,
    quoteId: body.quoteId.trim(),
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

function refundReference(orderId: string) {
  return `NIMFUEL:REFUND:${orderId}`
}

function refundInstruction(order: NimfuelOrder) {
  if (!order.refundRecipient || order.refundAmountLuna === undefined) return null
  return {
    recipient: formatNimAddress(order.refundRecipient),
    amountLuna: order.refundAmountLuna.toString(),
    amountNim: formatUnits(order.refundAmountLuna, 5),
    reference: refundReference(order.id),
  }
}

async function verifyRefundPayment(orderId: string, body: Record<string, unknown>) {
  const order = await orderForId(orderId)
  const txHash = normalizeNimTransactionHash(body.txHash)

  if (order.state === 'REFUNDED') {
    if (order.refundTxHash === txHash) return order
    throw new Error('This order has already been refunded with a different transaction.')
  }
  if (order.state !== 'REFUND_PENDING') throw new Error('This order does not have a pending refund.')
  if (!order.refundRecipient || order.refundAmountLuna === undefined) {
    throw new Error('The refund instruction is incomplete.')
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
  const expectedData = normalizeHexData(encodeNimReference(refundReference(order.id)))
  const expectedSender = config.refundSenderAddress
    ? requireNimAddress(config.refundSenderAddress, 'NIM refund sender')
    : null
  const senderMatches = expectedSender === null || await nimTransactionSenderMatchesOrder(transaction, expectedSender)
  const matchesRefund = transactionHash === txHash
    && transaction.executionResult === true
    && blockNumber > 0n
    && confirmations >= 1n
    && senderMatches
    && to === normalizeNimAddress(order.refundRecipient)
    && value === order.refundAmountLuna
    && recipientData === expectedData

  if (!matchesRefund) {
    await recordRefundFailure(orderId, 'The NIM refund did not match the expected sender, recipient, amount, reference, or confirmation state.')
    throw new Error('NIM refund did not match this order.')
  }

  if (!Number.isSafeInteger(Number(blockNumber))) throw new Error('Nimiq block number is outside the supported range.')
  if (!Number.isSafeInteger(Number(confirmations))) throw new Error('Nimiq confirmations are outside the supported range.')

  return await confirmRefund({
    orderId,
    txHash,
    blockNumber: Number(blockNumber),
    confirmations: Number(confirmations),
  })
}

async function adminOrderSnapshot(order: NimfuelOrder) {
  const attempts = await getRelayAttemptsByOrderId(order.id)
  return {
    order: publicOrder(order),
    relayAttempts: attempts.map(relayResponseFromAttempt),
    relayAttemptsUsed: attempts.length,
    relayAttemptsRemaining: Math.max(0, config.relayMaxAttempts - attempts.length),
    refundInstruction: refundInstruction(order),
  }
}

async function adminLookup(request: import('node:http').IncomingMessage, url: URL) {
  requireAdmin(request)
  const orderId = url.searchParams.get('orderId')?.trim()
  const reference = url.searchParams.get('reference')?.trim()
  if (!orderId && !reference) throw new HttpError(400, 'Provide an orderId or exact reference.')

  const order = orderId ? await orderForId(orderId) : await getOrderByReference(reference!)
  if (!order) throw new HttpError(404, 'Order was not found.')
  return await adminOrderSnapshot(order)
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

function hasRelayAuthorization(body: Record<string, unknown>) {
  return [
    body.userAddress,
    body.recipient,
    body.amountRaw,
    body.nonce,
    body.deadline,
    body.functionSignature,
    body.signature,
  ].every(value => value !== undefined && value !== null)
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
  enforceLiveProofAmount(prepared.amountRaw)

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

  if (['REFUND_PENDING', 'REFUNDED'].includes(order.state)) {
    throw new Error('This order is in refund processing and cannot be relayed.')
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
  let prepared: Awaited<ReturnType<typeof prepareRelay>>
  if (order.state === 'NIM_PAYMENT_CONFIRMED' && !hasRelayAuthorization(body)) {
    if (!order.quoteId) throw new Error('This order has no stored authorization quote. Sign a new authorization to continue.')
    const quote = await getQuoteById(order.quoteId)
    if (!quote || quote.consumedOrderId !== order.id) {
      throw new Error('The stored authorization quote could not be recovered. Manual recovery is required.')
    }
    prepared = await prepareRelayAuthorization({
      userAddress: quote.userAddress,
      recipient: quote.recipient,
      amountRaw: quote.amountRaw,
      nonce: quote.nonce,
      deadline: quote.deadline,
      functionSignature: quote.functionSignature,
      signature: quote.signature,
    })
  } else {
    if (order.state === 'RELAY_FAILED' && !hasRelayAuthorization(body)) {
      throw new Error('A new EIP-712 authorization is required before retrying this failed relay.')
    }
    prepared = await prepareRelay(body)
  }
  if (prepared.userAddress.toLowerCase() !== order.evmAddress.toLowerCase()) {
    throw new Error('The relay authorization user does not match the paid order.')
  }
  if (prepared.recipient.toLowerCase() !== order.recipient.toLowerCase()) {
    throw new Error('The relay recipient does not match the paid order.')
  }
  if (prepared.amountRaw !== order.amountRaw) {
    throw new Error('The relay amount does not match the paid order.')
  }
  if (order.state === 'NIM_PAYMENT_CONFIRMED'
    && order.quoteAuthorizationDigest
    && prepared.authorizationDigest !== order.quoteAuthorizationDigest) {
    throw new Error('The relay authorization does not match the paid quote.')
  }
  if (!isLiveBroadcastEnabled()) throw new Error('Live broadcast is disabled.')

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
        if (Date.now() - attempt.createdAt < config.relayReservationGraceSeconds * 1000) continue
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
        nimPaymentConfigured: Boolean(config.nimRecipient && config.priceApiUrl),
        orderStorage: 'postgres',
        priceApiConfigured: Boolean(config.priceApiUrl),
        priceApiKeyConfigured: config.priceApiKeyConfigured,
        quoteConfigured: Boolean(config.priceApiUrl && config.quoteTtlSeconds),
        adminLookupConfigured: Boolean(config.adminApiToken),
        refundVerificationConfigured: Boolean(config.nimVerificationEndpoint),
        databaseConfigured: config.databaseConfigured,
        liveBroadcastEnabled: isLiveBroadcastEnabled(),
        relayMaxAttempts: config.relayMaxAttempts,
        amountPolicy: usdtAmountPolicy(),
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/v1/relay/capability') {
      sendJson(response, 200, await readCapability())
      return
    }

    if (request.method === 'POST' && url.pathname === '/v1/preflight') {
      sendJson(response, 200, await createPreflight(await readJson(request)))
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

    if (request.method === 'GET' && url.pathname === '/v1/admin/orders') {
      sendJson(response, 200, await adminLookup(request, url))
      return
    }

    const adminRefundVerifyMatch = url.pathname.match(/^\/v1\/admin\/orders\/([^/]+)\/refund\/verify$/)
    if (request.method === 'POST' && adminRefundVerifyMatch) {
      requireAdmin(request)
      const order = await verifyRefundPayment(decodeURIComponent(adminRefundVerifyMatch[1]), await readJson(request))
      sendJson(response, 200, await adminOrderSnapshot(order))
      return
    }

    const adminRefundMatch = url.pathname.match(/^\/v1\/admin\/orders\/([^/]+)\/refund$/)
    if (request.method === 'POST' && adminRefundMatch) {
      requireAdmin(request)
      const order = await requestRefund(decodeURIComponent(adminRefundMatch[1]))
      sendJson(response, 200, await adminOrderSnapshot(order))
      return
    }

    const adminOrderMatch = url.pathname.match(/^\/v1\/admin\/orders\/([^/]+)$/)
    if (request.method === 'GET' && adminOrderMatch) {
      requireAdmin(request)
      const order = await orderForId(decodeURIComponent(adminOrderMatch[1]))
      sendJson(response, 200, await adminOrderSnapshot(order))
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
    sendJson(response, error instanceof HttpError ? error.status : 400, { error: errorMessage(error) })
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
