import { Pool, type PoolClient } from 'pg'
import { config } from './config.js'

const databaseUrlValue = config.databaseUrl.trim().replace(/^(['"])(.*)\1$/, '$2')
const databaseUrl = new URL(databaseUrlValue)
const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, ''))

if (!databaseName) {
  throw new Error('DATABASE_URL must include a database name.')
}

export const pool = new Pool({
  host: databaseUrl.hostname,
  port: databaseUrl.port ? Number(databaseUrl.port) : 5432,
  user: decodeURIComponent(databaseUrl.username),
  password: decodeURIComponent(databaseUrl.password),
  database: databaseName,
  ssl: { rejectUnauthorized: true },
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
      'REFUND_PENDING',
      'REFUNDED',
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
    quote_id TEXT UNIQUE,
    quote_authorization_digest TEXT,
    quote_gas_estimate NUMERIC(78, 0),
    quote_gas_price NUMERIC(78, 0),
    quote_estimated_fee_raw NUMERIC(78, 0),
    quote_pol_price_usd_nanos NUMERIC(78, 0),
    quote_nim_price_usd_nanos NUMERIC(78, 0),
    quote_service_fee_bps INTEGER,
    quote_service_fee_luna NUMERIC(78, 0),
    quote_payment_amount_luna NUMERIC(78, 0),
    quote_relay_cost_luna NUMERIC(78, 0),
    quote_price_source TEXT,
    quote_created_at TIMESTAMPTZ,
    quote_expires_at TIMESTAMPTZ,
    refund_recipient TEXT,
    refund_amount_luna NUMERIC(78, 0),
    refund_requested_at TIMESTAMPTZ,
    refund_tx_hash TEXT UNIQUE,
    refund_block_number BIGINT,
    refund_confirmations INTEGER,
    refund_verified_at TIMESTAMPTZ,
    refund_last_error TEXT,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    authorization_digest TEXT NOT NULL UNIQUE,
    user_address TEXT NOT NULL,
    recipient TEXT NOT NULL,
    amount_raw NUMERIC(78, 0) NOT NULL CHECK (amount_raw > 0),
    nonce NUMERIC(78, 0) NOT NULL,
    deadline NUMERIC(78, 0) NOT NULL,
    decimals INTEGER NOT NULL,
    function_signature TEXT NOT NULL,
    signature TEXT NOT NULL,
    execute_data TEXT NOT NULL,
    gas_estimate NUMERIC(78, 0) NOT NULL,
    gas_price NUMERIC(78, 0) NOT NULL,
    estimated_fee_raw NUMERIC(78, 0) NOT NULL,
    relayer_address TEXT NOT NULL,
    pol_price_usd_nanos NUMERIC(78, 0) NOT NULL,
    nim_price_usd_nanos NUMERIC(78, 0) NOT NULL,
    service_fee_bps INTEGER NOT NULL,
    service_fee_luna NUMERIC(78, 0) NOT NULL,
    relay_cost_luna NUMERIC(78, 0) NOT NULL,
    payment_amount_luna NUMERIC(78, 0) NOT NULL,
    price_source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_order_id TEXT UNIQUE REFERENCES orders(id)
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
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_id TEXT UNIQUE`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_authorization_digest TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_gas_estimate NUMERIC(78, 0)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_gas_price NUMERIC(78, 0)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_estimated_fee_raw NUMERIC(78, 0)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_pol_price_usd_nanos NUMERIC(78, 0)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_nim_price_usd_nanos NUMERIC(78, 0)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_service_fee_bps INTEGER`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_service_fee_luna NUMERIC(78, 0)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_payment_amount_luna NUMERIC(78, 0)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_relay_cost_luna NUMERIC(78, 0)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_price_source TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_created_at TIMESTAMPTZ`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_expires_at TIMESTAMPTZ`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_recipient TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount_luna NUMERIC(78, 0)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_tx_hash TEXT UNIQUE`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_block_number BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_confirmations INTEGER`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_verified_at TIMESTAMPTZ`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_last_error TEXT`,
  `ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_state_check`,
  `ALTER TABLE orders ADD CONSTRAINT orders_state_check CHECK (state IN (
    'AWAITING_NIM_PAYMENT',
    'NIM_PAYMENT_CONFIRMED',
    'PAYMENT_EXPIRED',
    'PAYMENT_MISMATCH',
    'RELAY_BROADCASTING',
    'RELAY_SUBMITTED',
    'RELAY_FAILED',
    'RECOVERY_REQUIRED',
    'REFUND_PENDING',
    'REFUNDED',
    'FULFILLED'
  ))`,
  `CREATE INDEX IF NOT EXISTS quotes_expires_at_idx ON quotes (expires_at)`,
  `INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING`,
  `INSERT INTO schema_migrations (version) VALUES (2) ON CONFLICT (version) DO NOTHING`,
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
