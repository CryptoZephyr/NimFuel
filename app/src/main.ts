import { init } from '@nimiq/mini-app-sdk'
import './style.css'

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider
  }
}

type ResultState = 'pending' | 'pass' | 'fail' | 'info'

type Result = {
  label: string
  value: string
  state: ResultState
  detail?: string
}

type NimOrder = {
  orderId: string
  reference: string
  paymentRecipient: string
  paymentAmountLuna: string
  paymentAmountNim: number
  evmAddress: string
  recipient: string
  amountRaw: string
  state: string
  expiresAt: string
  paymentTxHash: string | null
  paymentBlockNumber: number | null
  paymentConfirmations: number | null
  relayAuthorizationDigest: string | null
  relayTxHash: string | null
  relayBlockNumber: number | null
  relaySubmittedAt: string | null
  relayVerifiedAt: string | null
  lastError: string | null
}

const appRoot = document.querySelector<HTMLDivElement>('#app')

if (!appRoot) {
  throw new Error('App root was not found.')
}

const root = appRoot

function resolveApiBaseUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return ''

  const configured = value.trim()
  try {
    const url = new URL(configured, window.location.origin)
    const localHostnames = new Set(['localhost', '127.0.0.1', '::1'])
    if (localHostnames.has(url.hostname) && !localHostnames.has(window.location.hostname)) {
      url.hostname = window.location.hostname
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    return configured.replace(/\/$/, '')
  }
}

const config = {
  apiBaseUrl: resolveApiBaseUrl(import.meta.env.PUBLIC_API_BASE_URL),
  chainId: import.meta.env.PUBLIC_POLYGON_CHAIN_ID,
  usdtAddress: import.meta.env.PUBLIC_USDT_ADDRESS,
  nimRecipient: import.meta.env.PUBLIC_NIMFUEL_NIM_RECIPIENT,
}

let nimiqPromise: ReturnType<typeof init> | null = null
let nimAddress: string | null = null
let evmAddress: string | null = null
let relayFeedback = ''
let nimPaymentFeedback = ''
let nimOrder: NimOrder | null = null
let relayRecipientDraft = ''
let relayAmountDraft = '0.1'
let renderedResults: Result[] = []
let renderedMessage = 'Ready to inspect the wallet providers.'
let renderedTone: 'neutral' | 'success' | 'error' = 'neutral'

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

function quantityToBigInt(value: unknown, label: string) {
  if (typeof value === 'bigint') return value

  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value)
  }

  if (typeof value === 'string') {
    const quantity = value.trim()
    if (/^0x[0-9a-f]+$/i.test(quantity) || /^\d+$/.test(quantity)) {
      return BigInt(quantity)
    }
  }

  throw new Error(`${label} returned an invalid quantity.`)
}

function parseTokenAmount(value: string, decimals: number) {
  const normalized = value.trim()
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error('Enter a positive USDT amount.')
  }

  const [whole, fraction = ''] = normalized.split('.')
  if (fraction.length > decimals) {
    throw new Error(`USDT supports at most ${decimals} decimal places.`)
  }

  const base = 10n ** BigInt(decimals)
  const fractionValue = fraction.padEnd(decimals, '0') || '0'
  const amount = BigInt(whole) * base + BigInt(fractionValue)
  if (amount <= 0n) throw new Error('Enter a positive USDT amount.')
  return amount
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

function encodeAddressArgument(address: string) {
  if (!/^0x[0-9a-f]{40}$/i.test(address)) {
    throw new Error('Provider returned an invalid EVM address.')
  }
  return address.slice(2).toLowerCase().padStart(64, '0')
}

function renderResult(result: Result) {
  const detail = result.detail ? `<small>${escapeHtml(result.detail)}</small>` : ''
  return `
    <div class="result result-${result.state}">
      <div>
        <span class="result-label">${escapeHtml(result.label)}</span>
        ${detail}
      </div>
      <span class="result-value">${escapeHtml(result.value)}</span>
    </div>
  `
}

function renderRelayPanel() {
  if (!evmAddress) return ''

  const relayReady = ['NIM_PAYMENT_CONFIRMED', 'RELAY_FAILED', 'RELAY_BROADCASTING', 'RELAY_SUBMITTED'].includes(nimOrder?.state || '')
  const relayNeedsReconciliation = ['RELAY_BROADCASTING', 'RELAY_SUBMITTED'].includes(nimOrder?.state || '')
  const relayButtonLabel = relayNeedsReconciliation
    ? 'Reconcile submitted relay'
    : nimOrder?.state === 'RELAY_FAILED'
      ? 'Sign and retry paid order'
      : relayReady
        ? 'Sign and relay paid order'
        : 'Confirm NIM payment first'

  return `
    <section class="panel relay-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">T11 / READ-ONLY RELAY CHECK</p>
          <h2>Prepare one USDT transfer</h2>
        </div>
        <span class="badge">${relayReady ? 'NIM paid' : 'NIM payment required'}</span>
      </div>
      <p class="form-help">The signature binds the recipient, amount, token, chain, and current user nonce. Read-only validation estimates gas. Live execution unlocks only after this order's NIM payment is confirmed.</p>
      <div class="form-grid">
        <label>
          <span>Recipient</span>
          <input id="relay-recipient" type="text" inputmode="text" autocomplete="off" placeholder="0x..." value="${escapeHtml(relayRecipientDraft || evmAddress)}" />
        </label>
        <label>
          <span>Amount in USDT</span>
          <input id="relay-amount" type="text" inputmode="decimal" value="${escapeHtml(relayAmountDraft)}" />
        </label>
      </div>
      <button id="sign-authorization" class="primary-button" type="button">Sign and validate authorization</button>
      <p class="form-help relay-live-help">The live test is limited to exactly 0.1 USDT. It will submit one Polygon transaction using the relayer's POL and verify the receipt.</p>
      <button id="execute-relay" class="primary-button relay-live-button" type="button" ${relayReady ? '' : 'disabled'}>${relayButtonLabel}</button>
      <p id="relay-status" class="relay-status" aria-live="polite">${escapeHtml(relayFeedback || 'Use a recipient you control for the first proof.')}</p>
    </section>
  `
}

function renderNimPaymentPanel() {
  if (!nimAddress || !evmAddress) return ''

  const orderDetails = nimOrder
    ? `
        <div class="payment-summary">
          <div><span>Order</span><strong>${escapeHtml(nimOrder.orderId)}</strong></div>
          <div><span>Pay to</span><strong>${escapeHtml(nimOrder.paymentRecipient)}</strong></div>
          <div><span>Amount</span><strong>${escapeHtml(String(nimOrder.paymentAmountNim))} NIM</strong></div>
          <div><span>Reference</span><strong>${escapeHtml(nimOrder.reference)}</strong></div>
          <div><span>State</span><strong>${escapeHtml(nimOrder.state)}</strong></div>
        </div>
      `
    : '<p class="form-help">Create an order first. The server will show the exact development quote and unique payment reference before the wallet confirmation.</p>'

  const action = nimOrder
    ? nimOrder.state === 'FULFILLED'
      ? '<span class="badge">Order fulfilled</span>'
      : nimOrder.paymentTxHash
        ? `<button id="verify-nim-payment" class="primary-button" type="button">Verify NIM payment</button>`
        : `<button id="pay-nim-order" class="primary-button" type="button">Pay ${escapeHtml(String(nimOrder.paymentAmountNim))} NIM in Nimiq Pay</button>`
    : '<button id="create-nim-order" class="primary-button" type="button">Create NIM payment order</button>'

  return `
    <section class="panel nim-payment-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">T20 / NIM PAYMENT GATE</p>
          <h2>Pay for the blocked action</h2>
        </div>
        <span class="badge">User approved</span>
      </div>
      <p class="form-help">The NIM payment is sent to the configured NimFuel recipient with an order-specific reference. Polygon fulfillment stays disabled until this payment is independently verified.</p>
      ${orderDetails}
      ${action}
      <p id="nim-payment-status" class="relay-status" aria-live="polite">${escapeHtml(nimPaymentFeedback || 'No NIM payment has been requested.')}</p>
    </section>
  `
}

function render(results: Result[], message: string, tone: 'neutral' | 'success' | 'error' = 'neutral') {
  renderedResults = results.map(result => ({ ...result }))
  renderedMessage = message
  renderedTone = tone
  root.innerHTML = `
    <div class="shell">
      <header class="masthead">
        <div>
          <p class="eyebrow">NIMFUEL / PROVIDER PROBE</p>
          <h1>Make the blocked action usable.</h1>
          <p class="lede">A local proof flow for NIM payment and Polygon USDT relay authorization.</p>
        </div>
        <span class="status-dot status-dot-${tone}" aria-label="${tone}"></span>
      </header>

      <section class="notice" aria-live="polite">
        <strong>${escapeHtml(message)}</strong>
        <span>Provider checks are read-only. NIM payment requires a separate wallet approval.</span>
      </section>

      <section class="panel config-panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">LOCAL CONFIGURATION</p>
            <h2>Current target</h2>
          </div>
          <span class="badge">Polygon</span>
        </div>
        <div class="config-grid">
          <div><span>API</span><strong>${escapeHtml(config.apiBaseUrl || 'missing')}</strong></div>
          <div><span>Chain ID</span><strong>${escapeHtml(config.chainId || 'missing')}</strong></div>
          <div><span>USDT contract</span><strong>${escapeHtml(shorten(config.usdtAddress || 'missing'))}</strong></div>
          <div><span>NIM recipient</span><strong>${escapeHtml(config.nimRecipient ? 'configured' : 'missing')}</strong></div>
        </div>
      </section>

      <section class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">PHASE 0 / PHASE 1</p>
            <h2>Provider checks</h2>
          </div>
          <button id="run-checks" class="primary-button" type="button">Run checks</button>
        </div>
        <div class="results" id="results">
          ${results.map(renderResult).join('')}
        </div>
      </section>

      ${renderNimPaymentPanel()}

      ${renderRelayPanel()}

      <footer>
        <span>Use inside Nimiq Pay for real provider results.</span>
        <span>Polygon broadcast is guarded by the paid-order gate.</span>
      </footer>
    </div>
  `

  document.querySelector<HTMLButtonElement>('#run-checks')?.addEventListener('click', runChecks)
  document.querySelector<HTMLButtonElement>('#sign-authorization')?.addEventListener('click', signRelayAuthorization)
  document.querySelector<HTMLButtonElement>('#execute-relay')?.addEventListener('click', signAndExecuteRelay)
  document.querySelector<HTMLButtonElement>('#create-nim-order')?.addEventListener('click', createNimPaymentOrder)
  document.querySelector<HTMLButtonElement>('#pay-nim-order')?.addEventListener('click', sendNimPayment)
  document.querySelector<HTMLButtonElement>('#verify-nim-payment')?.addEventListener('click', verifyNimPayment)
}

const initialResults: Result[] = [
  { label: 'Nimiq SDK', value: 'waiting', state: 'pending', detail: 'Open this app inside Nimiq Pay.' },
  { label: 'Nimiq account', value: 'not requested', state: 'info' },
  { label: 'Nimiq consensus', value: 'not checked', state: 'info' },
  { label: 'EVM provider', value: 'not checked', state: 'info' },
  { label: 'EVM account', value: 'not requested', state: 'info' },
  { label: 'Polygon chain', value: 'not checked', state: 'info' },
  { label: 'POL balance', value: 'not checked', state: 'info' },
  { label: 'USDT balance', value: 'not checked', state: 'info' },
  { label: 'USDT metadata', value: 'not checked', state: 'info' },
]

render(initialResults, 'Ready to inspect the wallet providers.')

function startNimiqInit() {
  try {
    nimiqPromise = init({ timeout: 10_000 })
    void nimiqPromise.catch(() => undefined)
  } catch {
    nimiqPromise = null
  }
}

startNimiqInit()

async function runChecks() {
  nimAddress = null
  evmAddress = null
  nimOrder = null
  relayFeedback = ''
  nimPaymentFeedback = ''
  const results: Result[] = initialResults.map(result => ({ ...result, state: 'pending' as ResultState }))
  render(results, 'Requesting provider access. Approve only the prompts you expect.')

  let nimiq: Awaited<ReturnType<typeof init>> | null = null
  try {
    if (!nimiqPromise) throw new Error('Nimiq SDK initialization did not start.')
    nimiq = await nimiqPromise
    results[0] = { label: 'Nimiq SDK', value: 'ready', state: 'pass' }

    const nimiqAccountsResult = await nimiq.listAccounts()
    if (!Array.isArray(nimiqAccountsResult)) {
      throw new Error('Nimiq account access returned an error.')
    }

    const [consensus, blockNumber] = await Promise.all([
      nimiq.isConsensusEstablished(),
      nimiq.getBlockNumber(),
    ])

    const nimiqAccounts = nimiqAccountsResult
    nimAddress = nimiqAccounts[0] || null

    results[1] = {
      label: 'Nimiq account',
      value: nimiqAccounts.length ? `${nimiqAccounts.length} available` : 'none returned',
      state: nimiqAccounts.length ? 'pass' : 'fail',
      detail: nimAddress ? `Account ${shorten(nimAddress, 8, 8)}` : undefined,
    }
    results[2] = {
      label: 'Nimiq consensus',
      value: consensus ? 'established' : 'not established',
      state: consensus ? 'pass' : 'fail',
      detail: `Block ${blockNumber}`,
    }
  } catch (error) {
    results[0] = {
      label: 'Nimiq SDK',
      value: 'unavailable',
      state: 'fail',
      detail: error instanceof Error ? error.message : 'Open the app inside Nimiq Pay.',
    }
  }

  const provider = window.ethereum
  if (!provider) {
    results[3] = {
      label: 'EVM provider',
      value: 'missing',
      state: 'fail',
      detail: 'window.ethereum was not injected.',
    }
    results[4] = { label: 'EVM account', value: 'unavailable', state: 'fail' }
    render(results, 'Nimiq Pay providers were not fully available.', 'error')
    return
  }

  results[3] = { label: 'EVM provider', value: 'injected', state: 'pass' }

  let failedStage = 'EVM account'

  try {
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as unknown
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') {
      throw new Error('No EVM account was returned.')
    }

    const address = accounts[0]
    results[4] = { label: 'EVM account', value: shorten(address), state: 'pass' }

    const polygonChainId = Number(config.chainId)
    if (!Number.isInteger(polygonChainId) || polygonChainId <= 0) {
      throw new Error('PUBLIC_POLYGON_CHAIN_ID is invalid.')
    }
    const polygonChainIdHex = `0x${polygonChainId.toString(16)}`

    failedStage = 'Polygon chain'
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: polygonChainIdHex }],
    })

    const chainId = await provider.request({ method: 'eth_chainId' })
    const actualChainId = Number(quantityToBigInt(chainId, 'Polygon chain ID'))

    results[5] = {
      label: 'Polygon chain',
      value: `chain ${actualChainId}`,
      state: actualChainId === polygonChainId ? 'pass' : 'fail',
      detail: actualChainId === polygonChainId ? 'Matches local configuration.' : `Expected ${polygonChainId}.`,
    }

    if (actualChainId !== polygonChainId) {
      throw new Error(`Nimiq Pay stayed on chain ${actualChainId}.`)
    }

    failedStage = 'POL balance'
    const nativeBalance = await provider.request({
      method: 'eth_getBalance',
      params: [address, 'latest'],
    })
    const nativeValue = formatUnits(quantityToBigInt(nativeBalance, 'POL balance'), 18)

    results[6] = {
      label: 'POL balance',
      value: `${nativeValue} POL`,
      state: 'pass',
      detail: 'Read from Polygon latest state.',
    }

    failedStage = 'USDT metadata'
    const decimals = await provider.request({
      method: 'eth_call',
      params: [{ to: config.usdtAddress, data: '0x313ce567' }, 'latest'],
    })
    const tokenDecimals = Number(quantityToBigInt(decimals, 'USDT decimals'))
    const symbol = await provider.request({
      method: 'eth_call',
      params: [{ to: config.usdtAddress, data: '0x95d89b41' }, 'latest'],
    })

    results[8] = {
      label: 'USDT metadata',
      value: typeof symbol === 'string' && symbol !== '0x' ? 'readable' : 'returned no data',
      state: typeof symbol === 'string' && symbol !== '0x' ? 'pass' : 'fail',
      detail: `Contract decimals call returned ${tokenDecimals}.`,
    }

    failedStage = 'USDT balance'
    const usdtBalance = await provider.request({
      method: 'eth_call',
      params: [{ to: config.usdtAddress, data: `0x70a08231${encodeAddressArgument(address)}` }, 'latest'],
    })
    const tokenValue = formatUnits(quantityToBigInt(usdtBalance, 'USDT balance'), tokenDecimals)

    results[7] = {
      label: 'USDT balance',
      value: `${tokenValue} USDT`,
      state: 'pass',
      detail: `Token decimals: ${tokenDecimals}`,
    }

    evmAddress = address
    render(results, 'Provider checks completed. No transaction was sent.', 'success')
  } catch (error) {
    const failedIndex = failedStage === 'EVM account'
      ? 4
      : failedStage === 'Polygon chain'
        ? 5
        : failedStage === 'POL balance'
          ? 6
          : failedStage === 'USDT balance'
            ? 7
            : 8
    results[failedIndex] = {
      label: failedStage,
      value: 'unavailable',
      state: 'fail',
      detail: providerErrorCode(error) === '4902'
        ? 'Polygon is not configured in Nimiq Pay.'
        : error instanceof Error ? error.message : 'The provider read failed.',
    }
    render(results, `${failedStage} could not be read.`, 'error')
  }
}

function responseError(body: unknown, fallback: string) {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'string' && error.trim()) return error
  }
  return fallback
}

function readRelayDraft() {
  const recipientInput = document.querySelector<HTMLInputElement>('#relay-recipient')
  const amountInput = document.querySelector<HTMLInputElement>('#relay-amount')
  if (recipientInput?.value.trim()) relayRecipientDraft = recipientInput.value.trim()
  if (amountInput?.value.trim()) relayAmountDraft = amountInput.value.trim()
}

async function createNimPaymentOrder() {
  try {
    if (!nimAddress || !evmAddress) throw new Error('Run the provider checks first.')
    if (!config.apiBaseUrl) throw new Error('PUBLIC_API_BASE_URL is missing.')

    readRelayDraft()
    const recipient = relayRecipientDraft || evmAddress
    encodeAddressArgument(recipient)
    const amountRaw = parseTokenAmount(relayAmountDraft, 6)
    nimPaymentFeedback = 'Creating a NIM payment order.'
    setNimPaymentStatus(nimPaymentFeedback)

    const response = await fetch(`${config.apiBaseUrl}/v1/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nimAddress,
        evmAddress,
        recipient,
        amountRaw: amountRaw.toString(),
      }),
    })
    const responseBody = await response.json() as NimOrder & { error?: string }
    if (!response.ok) throw new Error(responseError(responseBody, 'The server could not create the NIM order.'))

    nimOrder = responseBody
    nimPaymentFeedback = `Order ready. Review the ${responseBody.paymentAmountNim} NIM amount and reference before approving the wallet prompt.`
    render(renderedResults, renderedMessage, renderedTone)
  } catch (error) {
    nimPaymentFeedback = errorText(error, 'NIM order creation failed.')
    setNimPaymentStatus(nimPaymentFeedback, true)
  }
}

async function sendNimPayment() {
  try {
    if (!nimOrder) throw new Error('Create a NIM payment order first.')
    if (!nimiqPromise) throw new Error('Nimiq SDK initialization did not start.')
    const nimiq = await nimiqPromise
    nimPaymentFeedback = 'Refreshing the Nimiq account state before the payment approval.'
    setNimPaymentStatus(nimPaymentFeedback)
    const validityStartHeight = await nimiq.getBlockNumber()
    nimPaymentFeedback = `Waiting for approval to pay ${nimOrder.paymentAmountNim} NIM to NimFuel.`
    setNimPaymentStatus(nimPaymentFeedback)

    const result = await nimiq.sendBasicTransactionWithData({
      recipient: nimOrder.paymentRecipient,
      value: Number(nimOrder.paymentAmountLuna),
      data: nimOrder.reference,
      validityStartHeight,
    })
    if (typeof result !== 'string') throw new Error('Nimiq Pay returned no transaction hash.')

    nimOrder = { ...nimOrder, paymentTxHash: result }
    nimPaymentFeedback = `NIM payment submitted. Verifying transaction ${shorten(result, 10, 8)}.`
    render(renderedResults, renderedMessage, renderedTone)
    await verifyNimPayment()
  } catch (error) {
    nimPaymentFeedback = errorText(error, 'NIM payment failed.')
    setNimPaymentStatus(nimPaymentFeedback, true)
  }
}

async function verifyNimPayment() {
  try {
    if (!nimOrder?.paymentTxHash) throw new Error('Submit the NIM payment first.')
    if (!config.apiBaseUrl) throw new Error('PUBLIC_API_BASE_URL is missing.')
    nimPaymentFeedback = 'Checking the Nimiq transaction and order reference.'
    setNimPaymentStatus(nimPaymentFeedback)

    const response = await fetch(`${config.apiBaseUrl}/v1/orders/${encodeURIComponent(nimOrder.orderId)}/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: nimOrder.paymentTxHash }),
    })
    const responseBody = await response.json() as NimOrder & { error?: string }
    if (!response.ok) throw new Error(responseError(responseBody, 'NIM payment is not verified yet.'))

    nimOrder = responseBody
    nimPaymentFeedback = `NIM payment confirmed in block ${responseBody.paymentBlockNumber ?? 'unknown'}. Polygon fulfillment remains disabled.`
    render(renderedResults, renderedMessage, renderedTone)
  } catch (error) {
    nimPaymentFeedback = `${errorText(error, 'NIM payment verification failed.')} Use Verify NIM payment again after the transaction is included.`
    setNimPaymentStatus(nimPaymentFeedback, true)
  }
}

function setNimPaymentStatus(message: string, isError = false) {
  nimPaymentFeedback = message
  const status = document.querySelector<HTMLParagraphElement>('#nim-payment-status')
  if (!status) return
  status.textContent = message
  status.classList.toggle('relay-status-error', isError)
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

async function collectRelayPayload() {
  const provider = window.ethereum
  if (!provider || !evmAddress) {
    setRelayStatus('Run the provider checks first.', true)
    throw new Error('Run the provider checks first.')
  }

  const recipientInput = document.querySelector<HTMLInputElement>('#relay-recipient')
  const amountInput = document.querySelector<HTMLInputElement>('#relay-amount')
  if (!recipientInput || !amountInput) throw new Error('Relay form is unavailable.')

  const recipient = recipientInput.value.trim()
  relayRecipientDraft = recipient
  relayAmountDraft = amountInput.value.trim()
  encodeAddressArgument(recipient)
  const amountRaw = parseTokenAmount(amountInput.value, 6)
  if (!config.apiBaseUrl) throw new Error('PUBLIC_API_BASE_URL is missing.')

  setRelayStatus('Reading the current USDT meta-transaction nonce.')
  const nonceResponse = await provider.request({
    method: 'eth_call',
    params: [{ to: config.usdtAddress, data: encodeGetNonceData(evmAddress) }, 'latest'],
  })
  const nonce = quantityToBigInt(nonceResponse, 'USDT meta nonce')
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60)
  const functionSignature = encodeTransferData(recipient, amountRaw)
  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
      MetaTransaction: [
        { name: 'nonce', type: 'uint256' },
        { name: 'from', type: 'address' },
        { name: 'functionSignature', type: 'bytes' },
      ],
    },
    primaryType: 'MetaTransaction',
    domain: {
      name: 'USDT0',
      version: '1',
      verifyingContract: config.usdtAddress,
      salt: encodeBytes32Quantity(BigInt(config.chainId)),
    },
    message: {
      nonce: nonce.toString(),
      from: evmAddress,
      functionSignature,
    },
  }

  setRelayStatus('Waiting for the EIP-712 authorization approval.')
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [evmAddress, JSON.stringify(typedData)],
  })
  if (typeof signature !== 'string') throw new Error('Nimiq Pay returned no signature.')

  return {
    amountRaw: amountRaw.toString(),
    payload: {
      userAddress: evmAddress,
      recipient,
      amountRaw: amountRaw.toString(),
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      functionSignature,
      signature,
    } satisfies RelayPayload,
  }
}

async function signRelayAuthorization() {
  try {
    const { payload } = await collectRelayPayload()
    setRelayStatus('Sending the authorization to the local server for validation.')
    const response = await fetch(`${config.apiBaseUrl}/v1/relay/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const responseBody = await response.json() as { amount?: string; gasEstimate?: string; error?: string }
    if (!response.ok) throw new Error(responseBody.error || 'Server validation failed.')

    const amountInput = document.querySelector<HTMLInputElement>('#relay-amount')
    setRelayStatus(`Authorization validated for ${responseBody.amount || amountInput?.value || '0.1'} USDT. Estimated gas: ${responseBody.gasEstimate || 'unavailable'}. Nothing was broadcast.`)
  } catch (error) {
    setRelayStatus(error instanceof Error ? error.message : 'Authorization validation failed.', true)
  }
}

async function signAndExecuteRelay() {
  try {
    if (!nimOrder || !['NIM_PAYMENT_CONFIRMED', 'RELAY_FAILED', 'RELAY_BROADCASTING', 'RELAY_SUBMITTED'].includes(nimOrder.state)) {
      throw new Error('Confirm the NIM payment for this order before starting the relay.')
    }

    const reconciliationOnly = ['RELAY_BROADCASTING', 'RELAY_SUBMITTED'].includes(nimOrder.state)
    let requestBody: Record<string, unknown> = { orderId: nimOrder.orderId }
    if (reconciliationOnly) {
      setRelayStatus('Checking the stored Polygon transaction and waiting for confirmation.')
    } else {
      const { amountRaw, payload } = await collectRelayPayload()
      if (amountRaw !== '100000') {
        throw new Error('The first live relay is limited to exactly 0.1 USDT.')
      }
      requestBody = { ...payload, orderId: nimOrder.orderId }
      setRelayStatus('Submitting the signed 0.1 USDT relay. Waiting for Polygon confirmation.')
    }

    const response = await fetch(`${config.apiBaseUrl}/v1/relay/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    const responseBody = await response.json() as {
      amount?: string
      txHash?: string
      receiptStatus?: string
      verifiedStateChange?: boolean
      order?: NimOrder
      error?: string
    }
    if (!response.ok) throw new Error(responseBody.error || 'Live relay failed before broadcast.')

    if (responseBody.order) nimOrder = responseBody.order
    if (responseBody.receiptStatus === 'pending' || responseBody.order?.state === 'RELAY_SUBMITTED') {
      setRelayStatus(`Relay submitted${responseBody.txHash ? `. Polygon tx: ${responseBody.txHash}` : ''}. Reconcile again after Polygon includes it.`)
      render(renderedResults, renderedMessage, 'neutral')
      return
    }
    if (!responseBody.txHash || responseBody.receiptStatus !== 'success' || responseBody.verifiedStateChange !== true) {
      throw new Error(responseBody.txHash
        ? `Transaction ${responseBody.txHash} was not verified as a successful USDT transfer.`
        : 'The server returned no transaction hash.')
    }

    setRelayStatus(`Relay confirmed for ${responseBody.amount || '0.1'} USDT. Tx hash: ${responseBody.txHash}`)
    render(renderedResults, renderedMessage, 'success')
  } catch (error) {
    setRelayStatus(error instanceof Error ? error.message : 'Live relay failed.', true)
  }
}

function setRelayStatus(message: string, isError = false) {
  relayFeedback = message
  const status = document.querySelector<HTMLParagraphElement>('#relay-status')
  if (!status) return
  status.textContent = message
  status.classList.toggle('relay-status-error', isError)
}
