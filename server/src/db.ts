import { Pool, type PoolClient } from 'pg'
import { config } from './config.js'

const connectionString = config.databaseUrl.replace(/([?&]sslmode=)require(&|$)/i, '$1verify-full$2')

export const pool = new Pool({
  connectionString,
  max: 5,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
})

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    expected_payment_data_hex TEXT NOT NULL,
    nim_address TEXT NOT NULL,
    payment_recipient TEXT NOT NULL,
    payment_amount_luna NUMERIC(78, 0) NOT NULL CHECK (payment_amount_luna > 0),
    evm_address TEXT NOT NULL,
    recipient TEXT NOT NULL,
    amount_raw NUMERIC(78, 0) NOT NULL CHECK (amount_raw > 0),
    state TEXT NOT NULL CHECK (state IN (
      'AWAITING_NIM_PAYMENT',
      'NIM_PAYMENT_CONFIRMED',
      'PAYMENT_EXPIRED',
      'PAYMENT_MISMATCH',
      'RELAY_BROADCASTING',
      'RELAY_SUBMITTED',
      'RELAY_FAILED',
      'RECOVERY_REQUIRED',
      'FULFILLED'
    )),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    payment_tx_hash TEXT UNIQUE,
    payment_block_number BIGINT,
    payment_confirmations INTEGER,
    payment_verified_at TIMESTAMPTZ,
    relay_authorization_digest TEXT,
    relay_tx_hash TEXT UNIQUE,
    relay_block_number BIGINT,
    relay_submitted_at TIMESTAMPTZ,
    relay_verified_at TIMESTAMPTZ,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS relay_attempts (
    id BIGSERIAL PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    authorization_digest TEXT NOT NULL UNIQUE,
    nonce NUMERIC(78, 0) NOT NULL,
    deadline NUMERIC(78, 0) NOT NULL,
    user_address TEXT NOT NULL,
    recipient TEXT NOT NULL,
    amount_raw NUMERIC(78, 0) NOT NULL,
    decimals INTEGER NOT NULL,
    function_signature TEXT NOT NULL,
    signature TEXT NOT NULL,
    execute_data TEXT NOT NULL,
    gas_estimate NUMERIC(78, 0) NOT NULL,
    gas_price NUMERIC(78, 0) NOT NULL,
    estimated_fee_raw NUMERIC(78, 0) NOT NULL,
    relayer_address TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'BROADCASTING',
      'SUBMITTED',
      'CONFIRMED',
      'FAILED',
      'RECOVERY_REQUIRED'
    )),
    tx_hash TEXT UNIQUE,
    receipt_status TEXT,
    block_number BIGINT,
    gas_used NUMERIC(78, 0),
    transfer_verified BOOLEAN,
    nonce_advanced BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS orders_state_idx ON orders (state)`,
  `CREATE INDEX IF NOT EXISTS orders_expires_at_idx ON orders (expires_at)`,
  `CREATE INDEX IF NOT EXISTS relay_attempts_order_id_idx ON relay_attempts (order_id)`,
  `CREATE INDEX IF NOT EXISTS relay_attempts_status_idx ON relay_attempts (status)`,
  `INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING`,
] as const

export async function initializeDatabase() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const statement of schemaStatements) await client.query(statement)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function databaseHealth() {
  await pool.query('SELECT 1')
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function closeDatabase() {
  await pool.end()
}
