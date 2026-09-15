import { createPublicClient, http, parseEventLogs, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { pool } from '../src/db.js'
import { config, polygon, POLYGON_USDT_ADDRESS, requireAddress } from '../src/config.js'
import { tokenAbi } from '../src/relay.js'

type RelayRow = {
  id: string
  state: string
  evm_address: string
  recipient: string
  amount_raw: string
  relay_tx_hash: string
  relay_submitted_at: Date | string | null
  relay_authorization_digest: string | null
  attempt_status: string | null
  attempt_nonce: string | null
  attempt_tx_hash: string | null
  attempt_receipt_status: string | null
  attempt_transfer_verified: boolean | null
  attempt_nonce_advanced: boolean | null
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const suppliedHash = process.argv[2]?.trim().replace(/^0x/i, '').toLowerCase()
assert(suppliedHash && /^[0-9a-f]{64}$/.test(suppliedHash), 'Provide a 64-character hexadecimal Polygon transaction hash.')
const txHash = `0x${suppliedHash}` as Hex

const publicClient = createPublicClient({ chain: polygon, transport: http(config.polygonRpcUrl) })
const orderResult = await pool.query<RelayRow>(
  `SELECT
     o.id,
     o.state,
     o.evm_address,
     o.recipient,
     o.amount_raw,
     o.relay_tx_hash,
     o.relay_submitted_at,
     o.relay_authorization_digest,
     a.status AS attempt_status,
     a.nonce AS attempt_nonce,
     a.tx_hash AS attempt_tx_hash,
     a.receipt_status AS attempt_receipt_status,
     a.transfer_verified AS attempt_transfer_verified,
     a.nonce_advanced AS attempt_nonce_advanced
   FROM orders o
   LEFT JOIN relay_attempts a ON a.authorization_digest = o.relay_authorization_digest
   WHERE o.relay_tx_hash = $1`,
  [txHash],
)
const order = orderResult.rows[0]
assert(order, 'The supplied hash is not attached to a NimFuel order in Neon.')

const [receipt, transaction, nonceAfter, userPolBalance] = await Promise.all([
  publicClient.getTransactionReceipt({ hash: txHash }),
  publicClient.getTransaction({ hash: txHash }),
  publicClient.readContract({
    address: POLYGON_USDT_ADDRESS,
    abi: tokenAbi,
    functionName: 'getNonce',
    args: [requireAddress(order.evm_address, 'order EVM address')],
  }),
  publicClient.getBalance({ address: requireAddress(order.evm_address, 'order EVM address') }),
])

const transferEvents = parseEventLogs({
  abi: tokenAbi,
  eventName: 'Transfer',
  logs: receipt.logs,
  strict: false,
})
const exactTransfer = transferEvents.some(event => {
  const args = event.args as { from?: string; to?: string; value?: bigint }
  return args.from?.toLowerCase() === order.evm_address.toLowerCase()
    && args.to?.toLowerCase() === order.recipient.toLowerCase()
    && args.value === BigInt(order.amount_raw)
})

const expectedNonce = order.attempt_nonce === null ? null : BigInt(order.attempt_nonce)
const nonceAdvanced = expectedNonce !== null && nonceAfter >= expectedNonce + 1n
const relayerAccount = config.relayerPrivateKey ? privateKeyToAccount(config.relayerPrivateKey) : null
const relayerPaidGas = Boolean(
  relayerAccount
  && transaction.from.toLowerCase() === relayerAccount.address.toLowerCase()
  && transaction.to?.toLowerCase() === POLYGON_USDT_ADDRESS.toLowerCase()
  && receipt.gasUsed > 0n
  && (receipt.effectiveGasPrice ?? transaction.gasPrice ?? 0n) > 0n,
)

console.log(JSON.stringify({
  orderState: order.state,
  attemptStatus: order.attempt_status,
  receiptStatus: receipt.status,
  persistedHash: order.relay_tx_hash === txHash && order.attempt_tx_hash === txHash,
  persistedBeforeWait: Boolean(order.relay_submitted_at),
  exactTransfer,
  nonceAdvanced,
  relayerPaidGas,
  userPolZero: userPolBalance === 0n,
  blockNumber: receipt.blockNumber.toString(),
  gasUsed: receipt.gasUsed.toString(),
}))

await pool.end()
