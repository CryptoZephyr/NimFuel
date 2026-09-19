import { init } from '@nimiq/mini-app-sdk'
import './style.css'
import { renderDocs } from './docs.ts'

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider
  }
}

type ResultState = 'pending' | 'pass' | 'fail' | 'info'
type NoticeTone = 'neutral' | 'success' | 'error'
type FlowState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'authorizing'
  | 'preflighting'
  | 'quote_ready'
  | 'awaiting_nim_payment'
  | 'payment_detected'
  | 'payment_confirmed'
  | 'relaying'
  | 'confirming'
  | 'fulfilled'
  | 'recovery_required'
  | 'refunding'
  | 'refunded'
  | 'error'

type Result = {
  label: string
  value: string
  state: ResultState
  detail?: string
}

type NimQuote = {
  quoteId: string
  authorizationDigest: string
  userAddress: string
  recipient: string
  amountRaw: string
  nonce: string
  deadline: string
  gasEstimate: string
  gasPrice: string
  estimatedFeeRaw: string
  estimatedFeePol: string
  polPriceUsd: string
  nimPriceUsd: string
  serviceFeeBps: number
  serviceFeeLuna: string
  serviceFeeNim: string
  relayCostLuna: string
  relayCostNim: string
  paymentAmountLuna: string
  paymentAmountNim: string
  priceSource: string
  createdAt: string
  expiresAt: string
  relayCostUsd: string
  serviceCostUsd: string
  priceRetrievedAt: { nim: string; pol: string }
  priceDegraded?: boolean
}

type AmountPolicy = {
  minUsdtAmount: string
  maxUsdtAmount: string | null
  liveProofAmountUsdt: string | null
}

type NimOrder = {
  orderId: string
  reference: string
  paymentDataHex: string
  nimAddress: string
  paymentRecipient: string
  paymentAmountLuna: string
  paymentAmountNim: string
  evmAddress: string
  recipient: string
  amountRaw: string
  state: string
  createdAt: string
  expiresAt: string
  updatedAt: string
  paymentTxHash: string | null
  paymentBlockNumber: number | null
  paymentConfirmations: number | null
  paymentVerifiedAt: string | null
  relayAuthorizationDigest: string | null
  relayTxHash: string | null
  relayBlockNumber: number | null
  relaySubmittedAt: string | null
  relayVerifiedAt: string | null
  quoteId: string | null
  quoteExpiresAt: string | null
  refundRecipient: string | null
  refundAmountLuna: string | null
  refundAmountNim: string | null
  refundRequestedAt: string | null
  refundTxHash: string | null
  refundBlockNumber: number | null
  refundConfirmations: number | null
  refundVerifiedAt: string | null
  refundLastError: string | null
  lastError: string | null
}

type PreflightResponse = {
  amountPolicy: AmountPolicy
  preflight: {
    userUsdtBalance: string
    userPolBalance: string
    relayerPolBalance: string
    estimatedFeePol: string
    userCanPayGasDirectly: boolean
    relayerCanPayGas: boolean
  }
  quote: NimQuote
}

type CapabilityResponse = {
  amountPolicy: AmountPolicy
  relayMaxAttempts: number
  liveBroadcastEnabled: boolean
  relaySafetyPaused: boolean
  relaySafetyPauseMessage: string | null
}

type RelayPayload = {
  userAddress: string
  recipient: string
  amountRaw: string
  nonce: string
  deadline: string
  functionSignature: string
  signature: string
}

type RelayResponse = {
  txHash?: string
  receiptStatus?: string
  verifiedStateChange?: boolean
  order?: NimOrder
}

type OrderHistoryItem = {
  orderId: string
  reference: string
  state: string
  createdAt: string
  updatedAt: string
  expiresAt: string
  recipient: string
  amountRaw: string
  amountUsdt: string
  paymentAmountNim: string
  paymentTxHash: string | null
  relayTxHash: string | null
  relayBlockNumber: number | null
  refundTxHash: string | null
  lastError: string | null
}

type OrderHistoryResponse = {
  orders: OrderHistoryItem[]
  limit: number
}

type HealthResponse = {
  ok: boolean
  ready: boolean
  status: 'pass' | 'degraded' | 'fail'
  checkedAt: string
  checks: Record<string, { status: 'pass' | 'degraded' | 'fail'; detail: string }>
  relaySafetyPaused: boolean
  relaySafetyPauseMessage: string | null
}

const appRoot = document.querySelector<HTMLDivElement>('#app')
if (!appRoot) throw new Error('App root was not found.')

if (window.location.pathname === '/docs' || window.location.pathname.startsWith('/docs/')) {
  renderDocs(appRoot)
} else {

const root = appRoot
const config = {
  apiBaseUrl: resolveApiBaseUrl(import.meta.env.PUBLIC_API_BASE_URL),
  chainId: import.meta.env.PUBLIC_POLYGON_CHAIN_ID,
  usdtAddress: import.meta.env.PUBLIC_USDT_ADDRESS,
  nimRecipient: import.meta.env.PUBLIC_NIMFUEL_NIM_RECIPIENT,
}
const USDT_DECIMALS = 6
const ORDER_STORAGE_KEY = 'nimfuel:current-order-id'

let nimiqPromise: ReturnType<typeof init> | null = null
let nimAddress: string | null = null
let evmAddress: string | null = null
let nimQuote: NimQuote | null = null
let preflightInfo: PreflightResponse['preflight'] | null = null
let nimOrder: NimOrder | null = null
let relayRecipientDraft = ''
let relayAmountDraft = (import.meta.env.PUBLIC_DEFAULT_USDT_AMOUNT || '').trim()
let amountPolicy: AmountPolicy | null = null
let walletSnapshot = { pol: '', usdt: '' }
let results: Result[] = initialResults()
let flowState: FlowState = 'idle'
let noticeMessage = 'Run the wallet check to see if this action needs gas.'
let noticeTone: NoticeTone = 'neutral'
let targetFeedback = ''
let paymentFeedback = ''
let relayFeedback = ''
let historyOrders: OrderHistoryItem[] = []
let historyState: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
let historyFeedback = ''
let historyRequestId = 0
let serverStatus: 'unknown' | 'checking' | 'pass' | 'degraded' | 'fail' = 'unknown'
let relaySafetyPause = { active: false, message: '' }

function resolveApiBaseUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const configured = value.trim()
  try {
    const url = new URL(configured, window.location.origin)
    const localHostnames = new Set(['localhost', '127.0.0.1', '::1'])
    if (localHostnames.has(url.hostname) && !localHostnames.has(window.location.hostname)) url.hostname = window.location.hostname
    return url.toString().replace(/\/$/, '')
  } catch {
    return configured.replace(/\/$/, '')
  }
}

function initialResults(): Result[] {
  return [
    { label: 'Nimiq Pay', value: 'waiting', state: 'pending', detail: 'Open this app inside Nimiq Pay.' },
    { label: 'Nimiq account', value: 'not requested', state: 'info' },
    { label: 'Nimiq consensus', value: 'not checked', state: 'info' },
    { label: 'EVM wallet', value: 'not checked', state: 'info' },
    { label: 'Polygon network', value: 'not checked', state: 'info' },
    { label: 'POL balance', value: 'not checked', state: 'info' },
    { label: 'USDT balance', value: 'not checked', state: 'info' },
    { label: 'USDT contract', value: 'not checked', state: 'info' },
  ]
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function shorten(value: string, start = 8, end = 6) {
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function formatUnits(value: bigint, decimals: number) {
  if (decimals === 0) return value.toString()
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const fraction = value % base
  if (fraction === 0n) return whole.toString()
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole}.${fractionText}`
}

function formatLuna(value: string | number | null | undefined) {
  if (value === null || value === undefined) return 'unknown'
  try {
    return formatUnits(BigInt(value), 5)
  } catch {
    return String(value)
  }
}

function quantityToBigInt(value: unknown, label: string) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string') {
    const quantity = value.trim()
    if (/^0x[0-9a-f]+$/i.test(quantity) || /^\d+$/.test(quantity)) return BigInt(quantity)
  }
  throw new Error(`${label} returned an invalid quantity.`)
}

function parseTokenAmount(value: string, decimals: number) {
  const normalized = value.trim()
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Enter a positive USDT amount.')
  const [whole, fraction = ''] = normalized.split('.')
  if (fraction.length > decimals) throw new Error(`USDT supports at most ${decimals} decimal places.`)
  const base = 10n ** BigInt(decimals)
  const amount = BigInt(whole) * base + BigInt(fraction.padEnd(decimals, '0') || '0')
  if (amount <= 0n) throw new Error('Enter a positive USDT amount.')
  return amount
}

function amountPolicyHint() {
  if (!amountPolicy) return 'Enter the USDT amount you want to send. NimFuel checks the configured range before asking for authorization and calculates the NIM quote from live Polygon gas.'
  if (amountPolicy.liveProofAmountUsdt) {
    return `The current controlled proof accepts exactly ${amountPolicy.liveProofAmountUsdt} USDT. Other amounts become available when proof mode is closed.`
  }
  if (amountPolicy.maxUsdtAmount) {
    return `Enter between ${amountPolicy.minUsdtAmount} and ${amountPolicy.maxUsdtAmount} USDT. The final NIM quote is calculated from live Polygon gas and prices.`
  }
  return `Enter at least ${amountPolicy.minUsdtAmount} USDT. Your wallet balance is the effective upper limit, and the final NIM quote is calculated from live Polygon gas and prices.`
}

function validateClientAmountPolicy(amountRaw: bigint) {
  if (!amountPolicy) throw new Error('The USDT amount policy could not be loaded.')
  if (amountPolicy.liveProofAmountUsdt !== null) {
    const proofAmountRaw = parseTokenAmount(amountPolicy.liveProofAmountUsdt, USDT_DECIMALS)
    if (amountRaw !== proofAmountRaw) throw new Error(`The controlled live proof accepts exactly ${amountPolicy.liveProofAmountUsdt} USDT.`)
  }
  const minAmountRaw = parseTokenAmount(amountPolicy.minUsdtAmount, USDT_DECIMALS)
  if (amountRaw < minAmountRaw) throw new Error(`USDT amount must be at least ${amountPolicy.minUsdtAmount}.`)
  if (amountPolicy.maxUsdtAmount !== null) {
    const maxAmountRaw = parseTokenAmount(amountPolicy.maxUsdtAmount, USDT_DECIMALS)
    if (amountRaw > maxAmountRaw) throw new Error(`USDT amount must be at most ${amountPolicy.maxUsdtAmount}.`)
  }
}

async function loadAmountPolicy() {
  const response = await apiRequest<CapabilityResponse>('/v1/relay/capability')
  relaySafetyPause = {
    active: response.relaySafetyPaused,
    message: response.relaySafetyPauseMessage || 'Stablecoin relay is temporarily paused. No new relay transactions are being accepted.',
  }
  if (!response.amountPolicy) throw new Error('The server did not return a USDT amount policy.')
  amountPolicy = response.amountPolicy
  return amountPolicy
}

async function loadServiceHealth() {
  serverStatus = 'checking'
  try {
    const response = await apiRequest<HealthResponse>('/health')
    serverStatus = response.status
    relaySafetyPause = {
      active: response.relaySafetyPaused,
      message: response.relaySafetyPauseMessage || 'Stablecoin relay is temporarily paused. No new relay transactions are being accepted.',
    }
    return response
  } catch (error) {
    serverStatus = 'fail'
    throw error
  }
}

async function loadOrderHistory() {
  if (!evmAddress) return
  const address = evmAddress
  const requestId = ++historyRequestId
  historyState = 'loading'
  historyFeedback = ''
  render()
  try {
    const response = await apiRequest<OrderHistoryResponse>(`/v1/orders?evmAddress=${encodeURIComponent(address)}&limit=10`)
    if (requestId !== historyRequestId || evmAddress !== address) return
    historyOrders = Array.isArray(response.orders) ? response.orders : []
    historyState = 'ready'
  } catch (error) {
    if (requestId !== historyRequestId || evmAddress !== address) return
    historyOrders = []
    historyState = 'error'
    const message = errorText(error, 'Order history could not be loaded.')
    historyFeedback = /HTTP 404|Not found/i.test(message)
      ? 'Order history is unavailable from this server release. Confirm the hosted app and API are on the same deployment, then retry.'
      : friendlyError(error, 'Order history could not be loaded.')
  }
  render()
}

function encodeAddressArgument(address: string) {
  if (!/^0x[0-9a-f]{40}$/i.test(address)) throw new Error('Enter a valid Polygon address.')
  return address.slice(2).toLowerCase().padStart(64, '0')
}

function encodeTransferData(recipient: string, amount: bigint) {
  return `0xa9059cbb${encodeAddressArgument(recipient)}${amount.toString(16).padStart(64, '0')}`
}

function encodeGetNonceData(address: string) {
  return `0x2d0335ab${encodeAddressArgument(address)}`
}

function encodeBytes32Quantity(value: bigint) {
  return `0x${value.toString(16).padStart(64, '0')}`
}

function providerErrorCode(error: unknown) {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' || typeof code === 'string' ? String(code) : null
}

function errorText(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: unknown; reason?: unknown; error?: unknown }
    for (const candidate of [record.message, record.reason, record.error]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate
      if (typeof candidate === 'object' && candidate !== null && 'message' in candidate) {
        const nestedMessage = (candidate as { message?: unknown }).message
        if (typeof nestedMessage === 'string' && nestedMessage.trim()) return nestedMessage
      }
    }
  }
  return fallback
}

function friendlyError(error: unknown, fallback: string) {
  const message = errorText(error, fallback)
  if (message === 'Failed to fetch' || message.toLowerCase().includes('could not be reached')) return 'NimFuel could not be reached. Check that the server is running and try again.'
  if (message.includes('Live broadcast is disabled')) return 'The Polygon relay window is closed. Nothing was broadcast.'
  if (message.includes('NIM payment did not match')) return 'The NIM transaction did not match this order. Check the amount and reference, then verify again.'
  if (message.includes('already created an order')) return 'This authorization already belongs to an order. Continue that order instead of paying again.'
  if (message.includes('active order for authorization nonce')) return 'This wallet already has an active order. Finish or recover it before starting another action.'
  return message
}

function responseError(body: unknown, fallback: string) {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'string' && error.trim()) return error
  }
  return fallback
}

async function apiRequest<T>(path: string, init?: RequestInit) {
  if (!config.apiBaseUrl) throw new Error('The NimFuel API is not configured for this build.')
  let response: Response
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, init)
  } catch {
    throw new Error('NimFuel server could not be reached.')
  }
  let body: unknown = {}
  try {
    body = await response.json()
  } catch {
    if (!response.ok) throw new Error(`NimFuel returned HTTP ${response.status}.`)
  }
  if (!response.ok) throw new Error(responseError(body, `NimFuel returned HTTP ${response.status}.`))
  return body as T
}

function renderResult(result: Result) {
  const detail = result.detail ? `<small>${escapeHtml(result.detail)}</small>` : ''
  return `<div class="result result-${result.state}"><div><span class="result-label">${escapeHtml(result.label)}</span>${detail}</div><span class="result-value">${escapeHtml(result.value)}</span></div>`
}

function stateLabel(state: string) {
  return state.toLowerCase().replaceAll('_', ' ')
}

function quoteExpired(quote: NimQuote) {
  return Date.now() >= Date.parse(quote.expiresAt)
}

function isTerminalOrderState(state: string) {
  return ['PAYMENT_EXPIRED', 'FULFILLED', 'REFUNDED'].includes(state)
}

function rememberOrder(order: NimOrder | null) {
  try {
    if (order) localStorage.setItem(ORDER_STORAGE_KEY, order.orderId)
    else localStorage.removeItem(ORDER_STORAGE_KEY)
  } catch {
    // Some embedded wallet browsers disable local storage. The in-memory flow still works.
  }
}

function savedOrderId() {
  try {
    const queryOrderId = new URLSearchParams(window.location.search).get('orderId')?.trim()
    const storedOrderId = localStorage.getItem(ORDER_STORAGE_KEY)?.trim()
    const candidate = queryOrderId || storedOrderId
    return candidate && /^nf_[a-f0-9]+$/i.test(candidate) ? candidate : null
  } catch {
    return null
  }
}

async function restoreSavedOrder() {
  const orderId = savedOrderId()
  if (!orderId) return
  try {
    const order = await apiRequest<NimOrder>(`/v1/orders/${encodeURIComponent(orderId)}`)
    nimOrder = order
    nimAddress = order.nimAddress
    evmAddress = order.evmAddress
    relayRecipientDraft = order.recipient
    relayAmountDraft = formatUnits(BigInt(order.amountRaw), USDT_DECIMALS)
    flowState = flowStateForOrder(order)
    setNotice('Your previous order was restored. Continue it here.', isTerminalOrderState(order.state) ? 'success' : 'neutral')
    render()
    void loadOrderHistory()
  } catch {
    rememberOrder(null)
  }
}

function clearCurrentOrder() {
  if (!nimOrder || !isTerminalOrderState(nimOrder.state)) return
  rememberOrder(null)
  nimOrder = null
  nimQuote = null
  preflightInfo = null
  amountPolicy = null
  relayRecipientDraft = evmAddress || ''
  relayAmountDraft = (import.meta.env.PUBLIC_DEFAULT_USDT_AMOUNT || '').trim()
  targetFeedback = ''
  paymentFeedback = ''
  relayFeedback = ''
  flowState = evmAddress && nimAddress ? 'ready' : 'idle'
  setNotice('The previous order is closed. Prepare another USDT action.', 'success')
  render()
}

function renderNewActionButton() {
  if (!nimOrder || !isTerminalOrderState(nimOrder.state)) return ''
  return '<button id="start-new-action" class="secondary-button" type="button">Start another USDT action</button>'
}

function setNotice(message: string, tone: NoticeTone = 'neutral') {
  noticeMessage = message
  noticeTone = tone
}

function setTargetStatus(message: string, isError = false) {
  targetFeedback = message
  const element = document.querySelector<HTMLParagraphElement>('#target-status')
  if (!element) return
  element.textContent = message
  element.classList.toggle('status-error', isError)
}

function setPaymentStatus(message: string, isError = false) {
  paymentFeedback = message
  const element = document.querySelector<HTMLParagraphElement>('#payment-status')
  if (!element) return
  element.textContent = message
  element.classList.toggle('status-error', isError)
}

function setRelayStatus(message: string, isError = false) {
  relayFeedback = message
  const element = document.querySelector<HTMLParagraphElement>('#relay-status')
  if (!element) return
  element.textContent = message
  element.classList.toggle('status-error', isError)
}

function renderWalletPanel() {
  const apiReady = Boolean(config.apiBaseUrl) && serverStatus !== 'fail'
  const apiLabel = serverStatus === 'checking'
    ? 'Checking API'
    : serverStatus === 'pass'
      ? 'API ready'
      : serverStatus === 'degraded'
        ? 'API degraded'
        : serverStatus === 'fail'
          ? 'API unavailable'
          : apiReady ? 'API configured' : 'API missing'
  return `
    <section class="panel wallet-panel">
      <div class="section-heading"><div><p class="eyebrow">WALLET CHECK</p><h2>See what your wallet can do</h2></div><span class="badge ${serverStatus === 'pass' ? 'badge-good' : serverStatus === 'fail' ? 'badge-warn' : ''}">${apiLabel}</span></div>
      <p class="form-help">NimFuel reads your Nimiq Pay account, Polygon network, USDT balance, and POL balance before asking you to approve anything.</p>
      <div class="results" id="results">${results.map(renderResult).join('')}</div>
      <button id="run-checks" class="primary-button" type="button" ${flowState === 'connecting' ? 'disabled' : ''}>${flowState === 'connecting' ? 'Checking wallet...' : 'Run wallet check'}</button>
    </section>
  `
}

function renderActionPanel() {
  if (!evmAddress || !nimAddress) {
    return `<section class="panel muted-panel"><p class="eyebrow">USDT ACTION</p><h2>Connect your Nimiq Pay wallet to continue.</h2><p class="form-help">NimFuel needs both the Nimiq Pay account and the Polygon wallet before it can prepare a quote.</p></section>`
  }

  if (relaySafetyPause.active) {
    return `<section class="panel muted-panel"><p class="eyebrow">TEMPORARY SAFETY PAUSE</p><h2>New stablecoin relays are paused.</h2><p class="form-help">${escapeHtml(relaySafetyPause.message)} You can still run wallet checks and review existing orders.</p></section>`
  }

  const locked = Boolean(nimOrder)
  const busy = ['authorizing', 'preflighting', 'connecting'].includes(flowState)
  const defaultRecipient = relayRecipientDraft || evmAddress
  const gasNote = walletSnapshot.pol === '0 POL'
    ? 'Your Polygon wallet has no POL. NimFuel can cover the relay gas using NIM.'
    : 'NimFuel will show the exact NIM cost after checking the live Polygon fee.'
  return `
    <section class="panel action-panel">
      <div class="section-heading"><div><p class="eyebrow">USDT ACTION</p><h2>Choose the action you need</h2></div><span class="badge">Polygon</span></div>
      <p class="form-help">${escapeHtml(gasNote)} Choose any amount accepted by the live server policy. ${escapeHtml(amountPolicyHint())}</p>
      <div class="form-grid">
        <label><span>Where should USDT go?</span><input id="relay-recipient" type="text" inputmode="text" autocomplete="off" placeholder="0x recipient" value="${escapeHtml(defaultRecipient)}" ${locked ? 'disabled' : ''} /></label>
        <label><span>How much USDT?</span><input id="relay-amount" type="text" inputmode="decimal" placeholder="Enter amount" value="${escapeHtml(relayAmountDraft)}" ${locked ? 'disabled' : ''} /></label>
      </div>
      ${preflightInfo ? `<div class="inline-metrics"><span>Your USDT <strong>${escapeHtml(preflightInfo.userUsdtBalance)}</strong></span><span>Your POL <strong>${escapeHtml(preflightInfo.userPolBalance)}</strong></span><span>Estimated gas <strong>${escapeHtml(preflightInfo.estimatedFeePol)} POL</strong></span></div>` : ''}
      ${locked ? '' : `<button id="prepare-quote" class="primary-button" type="button" ${busy ? 'disabled' : ''}>${nimQuote ? 'Refresh quote' : 'Get quote and continue'}</button>`}
      <p id="target-status" class="status-line" aria-live="polite">${escapeHtml(targetFeedback || (nimQuote ? 'Quote is stored safely for this action.' : 'The next step opens one authorization request in your wallet.'))}</p>
    </section>
  `
}

function renderQuotePanel() {
  if (!nimQuote || nimOrder) return ''
  const expired = quoteExpired(nimQuote)
  return `
    <section class="panel quote-panel">
      <div class="section-heading"><div><p class="eyebrow">QUOTE READY</p><h2>Review the NIM cost</h2></div><span class="badge ${expired ? 'badge-warn' : 'badge-good'}">${expired ? 'Expired' : nimQuote.priceDegraded ? 'Protected quote' : 'Live quote'}</span></div>
      <div class="quote-hero"><span>You pay</span><strong>${escapeHtml(nimQuote.paymentAmountNim)} NIM</strong><small>Quote expires ${escapeHtml(new Date(nimQuote.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</small></div>
      <div class="summary-list"><div><span>USDT action</span><strong>${escapeHtml(formatUnits(BigInt(nimQuote.amountRaw), USDT_DECIMALS))} USDT</strong></div><div><span>Estimated Polygon gas</span><strong>${escapeHtml(nimQuote.estimatedFeePol)} POL</strong></div><div><span>Gas and service value</span><strong>$${escapeHtml(nimQuote.serviceCostUsd)} USD</strong></div><div><span>Payment reference</span><strong>Created after you continue</strong></div></div>
      <button id="create-nim-order" class="primary-button" type="button" ${expired ? 'disabled' : ''}>Continue with NIM</button>
      <p class="status-line">${nimQuote.priceDegraded ? 'One market source was unavailable. This quote used a bounded fallback or recent safe price.' : 'The quote used the configured live market sources.'} The authorization is bound to this quote, and no Polygon transaction has been sent.</p>
    </section>
  `
}

function renderPaymentPanel() {
  if (!nimOrder || nimOrder.state === 'FULFILLED') return ''
  const paymentNim = String(nimOrder.paymentAmountNim)
  let action = ''
  if (relaySafetyPause.active && ['AWAITING_NIM_PAYMENT', 'PAYMENT_MISMATCH'].includes(nimOrder.state)) action = '<span class="badge badge-warn wide-badge">Payment paused</span>'
  else if (nimOrder.state === 'AWAITING_NIM_PAYMENT' && nimOrder.paymentTxHash) action = '<button id="verify-nim-payment" class="primary-button" type="button">Verify NIM payment</button>'
  else if (['AWAITING_NIM_PAYMENT', 'PAYMENT_MISMATCH'].includes(nimOrder.state)) action = `<button id="pay-nim-order" class="primary-button" type="button">Pay ${escapeHtml(paymentNim)} NIM in Nimiq Pay</button>`
  else if (nimOrder.state === 'NIM_PAYMENT_CONFIRMED') action = '<span class="badge badge-good wide-badge">NIM payment confirmed</span>'
  else if (nimOrder.state === 'PAYMENT_EXPIRED') action = '<span class="badge badge-warn wide-badge">Payment order expired</span>'

  return `
    <section class="panel payment-panel">
      <div class="section-heading"><div><p class="eyebrow">NIM PAYMENT</p><h2>Use NIM for Polygon gas</h2></div><span class="badge">${escapeHtml(stateLabel(nimOrder.state))}</span></div>
      <p class="form-help">Pay the exact amount to NimFuel with the order reference. Polygon fulfillment stays locked until the payment is independently verified.</p>
      <div class="summary-list"><div><span>Amount</span><strong>${escapeHtml(paymentNim)} NIM</strong></div><div><span>Pay to</span><strong>${escapeHtml(shorten(nimOrder.paymentRecipient, 10, 8))}</strong></div><div><span>Reference</span><strong>${escapeHtml(nimOrder.reference)}</strong></div>${nimOrder.paymentBlockNumber ? `<div><span>Included in block</span><strong>${escapeHtml(String(nimOrder.paymentBlockNumber))}</strong></div>` : ''}</div>
      ${action}
      <p id="payment-status" class="status-line" aria-live="polite">${escapeHtml(paymentFeedback || (relaySafetyPause.active ? relaySafetyPause.message : nimOrder.paymentTxHash ? 'Payment submitted. Verify it after inclusion.' : 'No payment has been requested yet.'))}</p>
      ${renderNewActionButton()}
    </section>
  `
}

function renderRelayPanel() {
  if (!nimOrder || ['AWAITING_NIM_PAYMENT', 'PAYMENT_MISMATCH', 'PAYMENT_EXPIRED', 'FULFILLED', 'RECOVERY_REQUIRED', 'REFUND_PENDING', 'REFUNDED'].includes(nimOrder.state)) return ''
  const pending = ['RELAY_BROADCASTING', 'RELAY_SUBMITTED'].includes(nimOrder.state)
  const failed = nimOrder.state === 'RELAY_FAILED'
  const buttonLabel = pending ? 'Check Polygon status' : failed ? 'Authorize a safe retry' : 'Relay paid USDT action'
  const explanation = failed
    ? 'The previous Polygon attempt did not complete. A new authorization is required, and the paid order remains the same.'
    : pending
      ? 'The Polygon transaction has a durable record. Check again after the network includes it.'
      : 'Your payment is confirmed. NimFuel will use the stored authorization and its POL to submit the USDT action.'
  const paused = relaySafetyPause.active
  return `
    <section class="panel relay-panel">
      <div class="section-heading"><div><p class="eyebrow">POLYGON FULFILLMENT</p><h2>${pending ? 'Confirming your action' : 'Your paid action is ready'}</h2></div><span class="badge ${failed ? 'badge-warn' : ''}">${escapeHtml(stateLabel(nimOrder.state))}</span></div>
      <div class="stage-list"><div class="stage stage-done"><span>01</span><strong>NIM payment confirmed</strong></div><div class="stage ${pending ? 'stage-active' : failed ? 'stage-warn' : 'stage-next'}"><span>02</span><strong>${pending ? 'Polygon transaction submitted' : failed ? 'Polygon retry available' : 'Relay with POL'}</strong></div><div class="stage stage-next"><span>03</span><strong>Verify USDT receipt</strong></div></div>
      <p class="form-help">${escapeHtml(paused ? relaySafetyPause.message : explanation)}</p>
      ${paused ? '<span class="badge badge-warn wide-badge">Relay paused</span>' : `<button id="relay-paid-order" class="primary-button relay-button" type="button">${buttonLabel}</button>`}
      <p id="relay-status" class="status-line" aria-live="polite">${escapeHtml(paused ? 'Your existing order remains saved for operator review.' : relayFeedback || nimOrder.lastError || 'No Polygon transaction has been broadcast from this page yet.')}</p>
    </section>
  `
}

function renderSuccessPanel() {
  if (!nimOrder || nimOrder.state !== 'FULFILLED') return ''
  const polygonLink = nimOrder.relayTxHash ? `<a href="https://polygonscan.com/tx/${encodeURIComponent(nimOrder.relayTxHash)}" target="_blank" rel="noreferrer">View Polygon receipt</a>` : ''
  return `
    <section class="panel success-panel"><span class="success-mark">✓</span><p class="eyebrow">FULFILLED</p><h2>Done. Your USDT action succeeded.</h2><p class="lede">The Polygon receipt and intended USDT state change were verified before this result appeared.</p><div class="summary-list"><div><span>NIM payment</span><strong>${escapeHtml(nimOrder.paymentTxHash ? shorten(nimOrder.paymentTxHash, 12, 10) : 'verified')}</strong></div><div><span>Polygon transaction</span><strong>${escapeHtml(nimOrder.relayTxHash ? shorten(nimOrder.relayTxHash, 12, 10) : 'verified')}</strong></div></div>${polygonLink ? `<div class="link-row">${polygonLink}</div>` : ''}${renderNewActionButton()}</section>
  `
}

function renderRecoveryPanel() {
  if (!nimOrder || !['RECOVERY_REQUIRED', 'REFUND_PENDING', 'REFUNDED'].includes(nimOrder.state)) return ''
  const refunded = nimOrder.state === 'REFUNDED'
  const pending = nimOrder.state === 'REFUND_PENDING'
  return `
    <section class="panel recovery-panel"><div class="section-heading"><div><p class="eyebrow">${refunded ? 'REFUND VERIFIED' : pending ? 'REFUND IN PROGRESS' : 'RECOVERY REQUIRED'}</p><h2>${refunded ? 'Your NIM refund was verified.' : 'Your NIM payment is safe in this order.'}</h2></div><span class="badge ${refunded ? 'badge-good' : 'badge-warn'}">${escapeHtml(stateLabel(nimOrder.state))}</span></div><p class="form-help">${refunded ? 'The refund transaction matched the order recipient, amount, reference, and confirmation state.' : 'The Polygon action has not completed. The order reference below lets support retry safely or issue and verify a refund without charging you again.'}</p><div class="summary-list"><div><span>Order reference</span><strong>${escapeHtml(nimOrder.reference)}</strong></div><div><span>Refund amount</span><strong>${escapeHtml(nimOrder.refundAmountNim || formatLuna(nimOrder.paymentAmountLuna))} NIM</strong></div>${nimOrder.refundTxHash ? `<div><span>Refund transaction</span><strong>${escapeHtml(shorten(nimOrder.refundTxHash, 12, 10))}</strong></div>` : ''}</div>${pending ? '<p class="status-line">Refund verification is pending. Keep this order reference for support.</p>' : ''}${renderNewActionButton()}</section>
  `
}

function historyTime(value: string) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : 'Unknown time'
}

function renderHistoryPanel() {
  if (!evmAddress) return ''
  if (historyState === 'loading') {
    return '<section class="panel history-panel"><div class="section-heading"><div><p class="eyebrow">ORDER HISTORY</p><h2>Loading your recent actions</h2></div></div><p class="form-help">NimFuel is syncing the durable order record.</p></section>'
  }
  if (historyState === 'error') {
    return '<section class="panel history-panel"><div class="section-heading"><div><p class="eyebrow">ORDER HISTORY</p><h2>Your history could not be loaded</h2></div><span class="badge badge-warn">Needs retry</span></div><p class="form-help">' + escapeHtml(historyFeedback || 'The server did not return the order history.') + '</p><button id="retry-history" class="secondary-button" type="button">Retry order history</button></section>'
  }
  if (historyOrders.length === 0) {
    return '<section class="panel history-panel"><div class="section-heading"><div><p class="eyebrow">ORDER HISTORY</p><h2>Your NimFuel history</h2></div><span class="badge">Empty</span></div><p class="form-help">Completed and in-progress actions will appear here after your first order.</p></section>'
  }
  const items = historyOrders.map(order => (
    '<button class="history-item" type="button" data-history-order="' + escapeHtml(order.orderId) + '">' +
      '<span><strong>' + escapeHtml(order.amountUsdt) + ' USDT</strong><small>' + escapeHtml(historyTime(order.updatedAt)) + '</small></span>' +
      '<span><strong>' + escapeHtml(stateLabel(order.state)) + '</strong><small>' + escapeHtml(shorten(order.orderId, 8, 6)) + '</small></span>' +
    '</button>'
  )).join('')
  return '<section class="panel history-panel"><div class="section-heading"><div><p class="eyebrow">ORDER HISTORY</p><h2>Return to a previous action</h2></div><span class="badge badge-good">' + historyOrders.length + ' saved</span></div><p class="form-help">These records come from NimFuel&apos;s durable order store. Open one to review its current state and proof.</p><div class="history-list">' + items + '</div></section>'
}

function refreshHistory() {
  if (evmAddress) void loadOrderHistory()
}

async function openHistoricalOrder(orderId: string) {
  try {
    nimOrder = await apiRequest<NimOrder>('/v1/orders/' + encodeURIComponent(orderId))
    nimAddress = nimOrder.nimAddress
    evmAddress = nimOrder.evmAddress
    relayRecipientDraft = nimOrder.recipient
    relayAmountDraft = formatUnits(BigInt(nimOrder.amountRaw), USDT_DECIMALS)
    flowState = flowStateForOrder(nimOrder)
    setNotice('Previous order restored. Review its current state below.', isTerminalOrderState(nimOrder.state) ? 'success' : 'neutral')
    render()
  } catch (error) {
    setNotice(friendlyError(error, 'That order could not be loaded.'), 'error')
    render()
  }
}

function render() {
  if (nimOrder) rememberOrder(nimOrder)
  root.innerHTML = `
    <div class="shell">
      <header class="masthead"><div class="brand-lockup" aria-label="NimFuel"><span class="brand-logo-frame"><img class="brand-logo" src="/nimfuel-logo.png" alt="" width="58" height="42" /></span><span class="brand-name">NimFuel</span></div><div class="masthead-actions"><a class="docs-header-link" href="/docs/start/introduction">Docs</a><span class="network-label">Polygon / NIM</span></div></header>
      <section class="hero"><p class="eyebrow">GAS FOR THE ACTION YOU ALREADY WANT</p><h1>Your USDT action needs Polygon gas. Use NIM to cover it.</h1><p class="lede">NimFuel lets a Nimiq Pay wallet complete a Polygon USDT action without first buying POL.</p></section>
      ${relaySafetyPause.active ? `<section class="notice notice-error" role="status"><span class="notice-dot"></span><div><strong>Stablecoin relay paused</strong><span>${escapeHtml(relaySafetyPause.message)}</span></div></section>` : ''}
      <section class="activation-path" aria-label="How NimFuel works">
        <div class="path-header"><p class="eyebrow">ONE CLEAR PATH</p><span class="path-note">NIM covers the gas. Your USDT action stays yours.</span></div>
        <ol class="path-steps">
          <li class="path-step"><span class="path-number">01</span><span><strong>Check</strong><small>Read wallet state</small></span></li>
          <li class="path-step"><span class="path-number">02</span><span><strong>Pay NIM</strong><small>Confirm the exact quote</small></span></li>
          <li class="path-step"><span class="path-number">03</span><span><strong>Relay</strong><small>Verify the Polygon receipt</small></span></li>
        </ol>
      </section>
      <section class="notice notice-${noticeTone}" aria-live="polite"><span class="notice-dot"></span><div><strong>${escapeHtml(noticeMessage)}</strong><span>Wallet prompts and payment checks appear only when the next step needs them.</span></div></section>
      ${renderWalletPanel()}
      ${renderActionPanel()}
      ${renderQuotePanel()}
      ${renderPaymentPanel()}
      ${renderRelayPanel()}
      ${renderSuccessPanel()}
      ${renderRecoveryPanel()}
      ${renderHistoryPanel()}
      <footer><span>Polygon chain ${escapeHtml(config.chainId || 'not configured')}</span><span>Payment is verified before fulfillment</span></footer>
    </div>
  `
  document.querySelector<HTMLButtonElement>('#run-checks')?.addEventListener('click', runChecks)
  document.querySelector<HTMLButtonElement>('#prepare-quote')?.addEventListener('click', prepareQuote)
  document.querySelector<HTMLButtonElement>('#create-nim-order')?.addEventListener('click', createNimPaymentOrder)
  document.querySelector<HTMLButtonElement>('#pay-nim-order')?.addEventListener('click', sendNimPayment)
  document.querySelector<HTMLButtonElement>('#verify-nim-payment')?.addEventListener('click', verifyNimPayment)
  document.querySelector<HTMLButtonElement>('#relay-paid-order')?.addEventListener('click', relayPaidOrder)
  document.querySelector<HTMLButtonElement>('#start-new-action')?.addEventListener('click', clearCurrentOrder)
  document.querySelector<HTMLButtonElement>('#retry-history')?.addEventListener('click', () => { void loadOrderHistory() })
  document.querySelectorAll<HTMLButtonElement>('[data-history-order]').forEach(button => {
    button.addEventListener('click', () => {
      const orderId = button.dataset.historyOrder
      if (!orderId) return
      setNotice('Loading the selected order.')
      render()
      void openHistoricalOrder(orderId)
    })
  })
}

render()
void loadServiceHealth().then(() => render()).catch(() => render())

function startNimiqInit() {
  try {
    nimiqPromise = init({ timeout: 10_000 })
    void nimiqPromise.catch(() => undefined)
  } catch {
    nimiqPromise = null
  }
}

startNimiqInit()
void restoreSavedOrder()

async function runChecks() {
  if (nimOrder && !isTerminalOrderState(nimOrder.state)) {
    setNotice('Finish or recover the current order before starting another action.', 'error')
    render()
    return
  }
  if (nimOrder) clearCurrentOrder()
  nimAddress = null
  evmAddress = null
  nimQuote = null
  preflightInfo = null
  nimOrder = null
  amountPolicy = null
  relayRecipientDraft = ''
  walletSnapshot = { pol: '', usdt: '' }
  targetFeedback = ''
  paymentFeedback = ''
  relayFeedback = ''
  historyOrders = []
  historyState = 'idle'
  historyFeedback = ''
  historyRequestId += 1
  serverStatus = 'checking'
  results = initialResults().map(result => ({ ...result, state: 'pending' as ResultState }))
  flowState = 'connecting'
  setNotice('Checking your wallet and network.')
  render()
  void loadServiceHealth().then(() => {
    if (!['authorizing', 'preflighting', 'awaiting_nim_payment', 'payment_detected', 'relaying', 'confirming'].includes(flowState)) render()
  }).catch(() => {
    if (!['authorizing', 'preflighting', 'awaiting_nim_payment', 'payment_detected', 'relaying', 'confirming'].includes(flowState)) render()
  })

  try {
    if (!nimiqPromise) throw new Error('Nimiq Pay initialization did not start.')
    const nimiq = await nimiqPromise
    results[0] = { label: 'Nimiq Pay', value: 'ready', state: 'pass' }
    const accountsResult = await nimiq.listAccounts()
    if (!Array.isArray(accountsResult)) throw new Error('Nimiq account access returned an error.')
    const [consensus, blockNumber] = await Promise.all([nimiq.isConsensusEstablished(), nimiq.getBlockNumber()])
    nimAddress = typeof accountsResult[0] === 'string' ? accountsResult[0] : null
    results[1] = { label: 'Nimiq account', value: accountsResult.length ? `${accountsResult.length} available` : 'none returned', state: accountsResult.length ? 'pass' : 'fail', detail: nimAddress ? `Account ${shorten(nimAddress, 8, 8)}` : undefined }
    results[2] = { label: 'Nimiq consensus', value: consensus ? 'established' : 'not established', state: consensus ? 'pass' : 'fail', detail: `Block ${blockNumber}` }
  } catch {
    results[0] = { label: 'Nimiq Pay', value: 'unavailable', state: 'fail', detail: 'Open the app inside Nimiq Pay.' }
  }

  const provider = window.ethereum
  if (!provider) {
    results[3] = { label: 'EVM wallet', value: 'missing', state: 'fail', detail: 'The Polygon wallet was not injected.' }
    results[4] = { label: 'Polygon network', value: 'unavailable', state: 'fail' }
    flowState = 'error'
    setNotice('Nimiq Pay providers were not fully available.', 'error')
    render()
    return
  }

  let failedStage = 'EVM wallet'
  try {
    const accounts = await provider.request({ method: 'eth_requestAccounts' }) as unknown
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') throw new Error('No Polygon wallet account was returned.')
    const address = accounts[0]
    results[3] = { label: 'EVM wallet', value: shorten(address), state: 'pass' }
    const polygonChainId = Number(config.chainId)
    if (!Number.isInteger(polygonChainId) || polygonChainId <= 0) throw new Error('The Polygon chain configuration is invalid.')
    failedStage = 'Polygon network'
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${polygonChainId.toString(16)}` }] })
    const chainId = await provider.request({ method: 'eth_chainId' })
    const actualChainId = Number(quantityToBigInt(chainId, 'Polygon chain ID'))
    results[4] = { label: 'Polygon network', value: `chain ${actualChainId}`, state: actualChainId === polygonChainId ? 'pass' : 'fail', detail: actualChainId === polygonChainId ? 'Matches NimFuel configuration.' : `Expected chain ${polygonChainId}.` }
    if (actualChainId !== polygonChainId) throw new Error(`Your wallet stayed on chain ${actualChainId}.`)
    failedStage = 'POL balance'
    const nativeBalance = await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] })
    const nativeValue = formatUnits(quantityToBigInt(nativeBalance, 'POL balance'), 18)
    walletSnapshot.pol = `${nativeValue} POL`
    results[5] = { label: 'POL balance', value: walletSnapshot.pol, state: 'pass', detail: 'Read from Polygon latest state.' }
    failedStage = 'USDT contract'
    const decimals = await provider.request({ method: 'eth_call', params: [{ to: config.usdtAddress, data: '0x313ce567' }, 'latest'] })
    const tokenDecimals = Number(quantityToBigInt(decimals, 'USDT decimals'))
    const symbol = await provider.request({ method: 'eth_call', params: [{ to: config.usdtAddress, data: '0x95d89b41' }, 'latest'] })
    results[7] = { label: 'USDT contract', value: typeof symbol === 'string' && symbol !== '0x' ? 'readable' : 'no data', state: typeof symbol === 'string' && symbol !== '0x' ? 'pass' : 'fail', detail: `Token decimals: ${tokenDecimals}` }
    failedStage = 'USDT balance'
    const usdtBalance = await provider.request({ method: 'eth_call', params: [{ to: config.usdtAddress, data: `0x70a08231${encodeAddressArgument(address)}` }, 'latest'] })
    const tokenValue = formatUnits(quantityToBigInt(usdtBalance, 'USDT balance'), tokenDecimals)
    walletSnapshot.usdt = `${tokenValue} USDT`
    results[6] = { label: 'USDT balance', value: walletSnapshot.usdt, state: 'pass', detail: `Token decimals: ${tokenDecimals}` }
    evmAddress = address
    relayRecipientDraft = address
    if (nimAddress) {
      flowState = 'ready'
      setNotice('Your wallet is ready. Choose the USDT action to prepare a quote.', 'success')
    } else {
      flowState = 'error'
      setNotice('Polygon is ready, but Nimiq Pay account access is still needed.', 'error')
    }
    render()
    void loadOrderHistory()
  } catch (error) {
    const failedIndex = failedStage === 'EVM wallet' ? 3 : failedStage === 'Polygon network' ? 4 : failedStage === 'POL balance' ? 5 : failedStage === 'USDT balance' ? 6 : 7
    results[failedIndex] = { label: failedStage, value: 'unavailable', state: 'fail', detail: providerErrorCode(error) === '4902' ? 'Polygon is not configured in Nimiq Pay.' : friendlyError(error, 'The wallet read failed.') }
    flowState = 'error'
    setNotice(`${failedStage} could not be read.`, 'error')
    render()
  }
}

function readRelayDraft() {
  const recipientInput = document.querySelector<HTMLInputElement>('#relay-recipient')
  const amountInput = document.querySelector<HTMLInputElement>('#relay-amount')
  if (recipientInput?.value.trim()) relayRecipientDraft = recipientInput.value.trim()
  if (amountInput?.value.trim()) relayAmountDraft = amountInput.value.trim()
}

async function collectRelayPayload(): Promise<RelayPayload> {
  const provider = window.ethereum
  if (!provider || !evmAddress) throw new Error('Run the wallet check first.')
  readRelayDraft()
  const recipient = relayRecipientDraft || evmAddress
  const amountRaw = parseTokenAmount(relayAmountDraft, USDT_DECIMALS)
  encodeAddressArgument(recipient)
  if (!config.apiBaseUrl) throw new Error('The NimFuel API is not configured for this build.')
  setTargetStatus('Reading the current USDT authorization nonce.')
  const nonceResponse = await provider.request({ method: 'eth_call', params: [{ to: config.usdtAddress, data: encodeGetNonceData(evmAddress) }, 'latest'] })
  const nonce = quantityToBigInt(nonceResponse, 'USDT authorization nonce')
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60)
  const functionSignature = encodeTransferData(recipient, amountRaw)
  const typedData = {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' }],
      MetaTransaction: [{ name: 'nonce', type: 'uint256' }, { name: 'from', type: 'address' }, { name: 'functionSignature', type: 'bytes' }],
    },
    primaryType: 'MetaTransaction',
    domain: { name: 'USDT0', version: '1', verifyingContract: config.usdtAddress, salt: encodeBytes32Quantity(BigInt(config.chainId)) },
    message: { nonce: nonce.toString(), from: evmAddress, functionSignature },
  }
  setTargetStatus('Review the USDT authorization in Nimiq Pay.')
  const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [evmAddress, JSON.stringify(typedData)] })
  if (typeof signature !== 'string') throw new Error('Nimiq Pay returned no authorization signature.')
  return { userAddress: evmAddress, recipient, amountRaw: amountRaw.toString(), nonce: nonce.toString(), deadline: deadline.toString(), functionSignature, signature }
}

async function prepareQuote() {
  try {
    if (!nimAddress || !evmAddress) throw new Error('Run the wallet check first.')
    await loadServiceHealth()
    if (relaySafetyPause.active) throw new Error(relaySafetyPause.message)
    readRelayDraft()
    const requestedAmountRaw = parseTokenAmount(relayAmountDraft, USDT_DECIMALS)
    if (!amountPolicy) {
      setNotice('Checking the accepted USDT amount range.')
      setTargetStatus('Checking the accepted USDT amount range before asking for authorization.')
      render()
      await loadAmountPolicy()
    }
    validateClientAmountPolicy(requestedAmountRaw)
    nimQuote = null
    preflightInfo = null
    nimOrder = null
    flowState = 'authorizing'
    setNotice('Review the USDT authorization in your wallet.')
    render()
    const payload = await collectRelayPayload()
    flowState = 'preflighting'
    setNotice('Checking the Polygon action and calculating the NIM cost.')
    setTargetStatus('Calculating a live NIM quote from the Polygon fee.')
    const response = await apiRequest<PreflightResponse>('/v1/preflight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    nimQuote = response.quote
    preflightInfo = response.preflight
    flowState = 'quote_ready'
    setNotice(`Quote ready. Review the exact ${response.quote.paymentAmountNim} NIM payment.`, 'success')
    targetFeedback = 'Authorization validated. Nothing was broadcast.'
    render()
  } catch (error) {
    flowState = 'error'
    const message = friendlyError(error, 'The Polygon preflight failed.')
    setNotice(message, 'error')
    setTargetStatus(message, true)
    render()
  }
}

async function createNimPaymentOrder() {
  try {
    if (!nimAddress || !nimQuote) throw new Error('Prepare a live quote first.')
    await loadServiceHealth()
    if (relaySafetyPause.active) throw new Error(relaySafetyPause.message)
    if (quoteExpired(nimQuote)) throw new Error('This quote expired. Prepare a new quote.')
    flowState = 'awaiting_nim_payment'
    setNotice('Creating your exact NIM payment order.')
    render()
    nimOrder = await apiRequest<NimOrder>('/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nimAddress, quoteId: nimQuote.quoteId }) })
    paymentFeedback = `Pay exactly ${nimOrder.paymentAmountNim} NIM with the reference shown below.`
    setNotice('Your order is ready. Pay the exact NIM amount shown below.', 'success')
    render()
    refreshHistory()
  } catch (error) {
    flowState = 'error'
    setNotice(friendlyError(error, 'The NIM payment order could not be created.'), 'error')
    render()
  }
}

function flowStateForOrder(order: NimOrder): FlowState {
  switch (order.state) {
    case 'NIM_PAYMENT_CONFIRMED': return 'payment_confirmed'
    case 'RELAY_BROADCASTING': return 'relaying'
    case 'RELAY_SUBMITTED': return 'confirming'
    case 'FULFILLED': return 'fulfilled'
    case 'RECOVERY_REQUIRED': return 'recovery_required'
    case 'REFUND_PENDING': return 'refunding'
    case 'REFUNDED': return 'refunded'
    case 'PAYMENT_MISMATCH': return 'error'
    default: return 'awaiting_nim_payment'
  }
}

async function refreshOrder() {
  if (!nimOrder) return
  const latest = await apiRequest<NimOrder>(`/v1/orders/${encodeURIComponent(nimOrder.orderId)}`)
  nimOrder = latest
  flowState = flowStateForOrder(latest)
  return latest
}

async function sendNimPayment() {
  try {
    if (!nimOrder) throw new Error('Create a NIM payment order first.')
    await loadServiceHealth()
    if (relaySafetyPause.active) throw new Error(relaySafetyPause.message)
    if (!nimiqPromise) throw new Error('Nimiq Pay initialization did not start.')
    const nimiq = await nimiqPromise
    flowState = 'awaiting_nim_payment'
    setNotice(`Waiting for approval to pay ${nimOrder.paymentAmountNim} NIM.`)
    render()
    const luna = BigInt(nimOrder.paymentAmountLuna)
    if (luna > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('This NIM amount is too large for the wallet payment adapter.')
    const validityStartHeight = await nimiq.getBlockNumber()
    const result = await nimiq.sendBasicTransactionWithData({ recipient: nimOrder.paymentRecipient, value: Number(luna), data: nimOrder.reference, validityStartHeight })
    if (typeof result !== 'string') throw new Error('Nimiq Pay returned no transaction hash.')
    nimOrder = { ...nimOrder, paymentTxHash: result }
    flowState = 'payment_detected'
    paymentFeedback = `NIM payment submitted. Verifying ${shorten(result, 10, 8)}.`
    setNotice('Your NIM payment was submitted. Waiting for independent verification.')
    render()
    await verifyNimPayment()
  } catch (error) {
    const message = friendlyError(error, 'NIM payment failed.')
    setNotice(message, 'error')
    setPaymentStatus(message, true)
    render()
  }
}

async function verifyNimPayment() {
  try {
    if (!nimOrder?.paymentTxHash) throw new Error('Submit the NIM payment first.')
    await loadServiceHealth()
    if (relaySafetyPause.active) throw new Error(relaySafetyPause.message)
    setNotice('Checking the Nimiq transaction and order reference.')
    setPaymentStatus('Checking the Nimiq transaction and order reference.')
    const response = await apiRequest<NimOrder>(`/v1/orders/${encodeURIComponent(nimOrder.orderId)}/verify-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash: nimOrder.paymentTxHash }) })
    nimOrder = response
    flowState = flowStateForOrder(response)
    paymentFeedback = `NIM payment confirmed in block ${response.paymentBlockNumber ?? 'unknown'}.`
    setNotice('Your NIM payment is confirmed. The paid Polygon action is ready.', 'success')
    render()
    refreshHistory()
  } catch (error) {
    try { await refreshOrder() } catch { /* Keep the submitted hash visible while the API recovers. */ }
    const message = friendlyError(error, 'NIM payment verification failed.')
    setNotice(message, 'error')
    setPaymentStatus(`${message} Verify again after the transaction is included.`, true)
    render()
  }
}

async function relayPaidOrder() {
  try {
    if (!nimOrder || !['NIM_PAYMENT_CONFIRMED', 'RELAY_FAILED', 'RELAY_BROADCASTING', 'RELAY_SUBMITTED'].includes(nimOrder.state)) throw new Error('Confirm the NIM payment for this order before relaying.')
    await loadServiceHealth()
    if (relaySafetyPause.active) throw new Error(relaySafetyPause.message)
    let requestBody: Record<string, unknown> = { orderId: nimOrder.orderId }
    if (nimOrder.state === 'RELAY_FAILED') {
      readRelayDraft()
      const amountRaw = parseTokenAmount(relayAmountDraft, USDT_DECIMALS).toString()
      if (amountRaw !== nimOrder.amountRaw || relayRecipientDraft.toLowerCase() !== nimOrder.recipient.toLowerCase()) throw new Error('Keep the original recipient and amount when retrying this paid order.')
      flowState = 'authorizing'
      setNotice('A retry needs a fresh USDT authorization.')
      render()
      const payload = await collectRelayPayload()
      requestBody = { ...payload, orderId: nimOrder.orderId }
    }
    flowState = 'relaying'
    setNotice(['RELAY_BROADCASTING', 'RELAY_SUBMITTED'].includes(nimOrder.state) ? 'Checking the stored Polygon transaction.' : 'NIM payment received. Relaying the Polygon action.')
    setRelayStatus('Waiting for the Polygon receipt.')
    render()
    const response = await apiRequest<RelayResponse>('/v1/relay/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) })
    if (response.order) nimOrder = response.order
    if (nimOrder?.state === 'RELAY_SUBMITTED' || response.receiptStatus === 'pending') {
      flowState = 'confirming'
      setNotice('The Polygon transaction was submitted. Check again after inclusion.')
      relayFeedback = response.txHash ? `Polygon transaction submitted: ${response.txHash}` : 'Polygon transaction submitted. Check again after inclusion.'
      render()
      refreshHistory()
      return
    }
    if (!response.txHash || response.receiptStatus !== 'success' || response.verifiedStateChange !== true || nimOrder?.state !== 'FULFILLED') throw new Error('The Polygon receipt was not verified as the intended USDT action.')
    flowState = 'fulfilled'
    relayFeedback = `Polygon transaction verified: ${response.txHash}`
    setNotice('Your USDT action succeeded.', 'success')
    render()
    refreshHistory()
  } catch (error) {
    try { await refreshOrder() } catch { /* Keep the current order state if the status read is temporarily unavailable. */ }
    const message = friendlyError(error, 'Polygon fulfillment failed.')
    setNotice(message, 'error')
    setRelayStatus(message, true)
    render()
  }
}
}
