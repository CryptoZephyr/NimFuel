export type NimiqTransaction = {
  hash?: unknown
  blockNumber?: unknown
  confirmations?: unknown
  timestamp?: unknown
  from?: unknown
  fromType?: unknown
  to?: unknown
  value?: unknown
  fee?: unknown
  recipientData?: unknown
  executionResult?: unknown
}

export type NimiqAccount = {
  address?: unknown
  balance?: unknown
  type?: unknown
  sender?: unknown
  recipient?: unknown
}

type NimiqRpcResponse = {
  result?: { data?: unknown }
  error?: { message?: unknown; data?: unknown }
}

export function normalizeNimAddress(value: string) {
  return value.replace(/\s+/g, '').toUpperCase()
}

export function requireNimAddress(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} must be a Nimiq user-friendly address.`)
  const normalized = normalizeNimAddress(value.trim())
  if (!/^NQ[A-Z0-9]{34}$/.test(normalized)) {
    throw new Error(`${label} must be a valid Nimiq user-friendly address.`)
  }
  return normalized
}

export function formatNimAddress(value: string) {
  const normalized = normalizeNimAddress(value)
  return normalized.match(/.{1,4}/g)?.join(' ') || normalized
}

export function normalizeNimTransactionHash(value: unknown) {
  if (typeof value !== 'string') throw new Error('txHash must be a 64-character hexadecimal Nimiq transaction hash.')
  const normalized = value.trim().replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('txHash must be a 64-character hexadecimal Nimiq transaction hash.')
  }
  return normalized
}

export function parseNimInteger(value: unknown, label: string) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && (/^\d+$/.test(value.trim()) || /^0x[0-9a-f]+$/i.test(value.trim()))) {
    return BigInt(value.trim())
  }
  throw new Error(`${label} returned an invalid integer.`)
}

export function encodeNimReference(value: string) {
  return Buffer.from(value, 'utf8').toString('hex')
}

async function readNimiqData(endpoint: string, method: string, params: unknown[], missingMessage: string) {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
  const apiKey = process.env.NIMIQ_VERIFICATION_API_KEY?.trim()
  if (apiKey) headers['X-API-Key'] = apiKey
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  })

  if (!response.ok) throw new Error(`Nimiq verification endpoint returned HTTP ${response.status}.`)

  const payload = await response.json() as NimiqRpcResponse
  if (payload.error) {
    const detail = typeof payload.error.data === 'string'
      ? payload.error.data
      : typeof payload.error.message === 'string'
        ? payload.error.message
        : 'Nimiq verification failed.'
    throw new Error(detail)
  }

  const data = payload.result?.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(missingMessage)
  }

  return data
}

export async function readNimiqTransaction(endpoint: string, hash: string) {
  return await readNimiqData(endpoint, 'getTransactionByHash', [hash], 'Nimiq verification returned no transaction data.') as NimiqTransaction
}

export async function readNimiqAccount(endpoint: string, address: string) {
  return await readNimiqData(endpoint, 'getAccountByAddress', [address], 'Nimiq verification returned no account data.') as NimiqAccount
}
