import { createPublicClient, formatUnits, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { databaseHealth } from './db.js'
import { config, isRelaySafetyPaused, polygon, POLYGON_CHAIN_ID, POLYGON_USDT_ADDRESS } from './config.js'
import { readNimiqAccount, parseNimInteger } from './nim.js'
import { readMarketPrices } from './prices.js'
import { tokenAbi } from './relay.js'

export type MonitorStatus = 'pass' | 'degraded' | 'fail'

export type HealthCheck = {
  status: MonitorStatus
  latencyMs: number
  detail: string
  checkedAt: string
  data?: Record<string, string | number | boolean | null>
}

export type HealthSnapshot = {
  status: MonitorStatus
  ready: boolean
  checkedAt: string
  checks: Record<string, HealthCheck>
  alertsConfigured: boolean
  liveBroadcastEnabled: boolean
  relaySafetyPaused: boolean
}

const publicClient = createPublicClient({ chain: polygon, transport: http(config.polygonRpcUrl) })
const relayerAccount = config.relayerPrivateKey ? privateKeyToAccount(config.relayerPrivateKey) : null

function statusRank(status: MonitorStatus) {
  return status === 'fail' ? 2 : status === 'degraded' ? 1 : 0
}

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : 'Dependency check failed.'
}

function check(status: MonitorStatus, startedAt: number, detail: string, data?: HealthCheck['data']): HealthCheck {
  return {
    status,
    latencyMs: Math.max(0, Date.now() - startedAt),
    detail,
    checkedAt: new Date().toISOString(),
    data,
  }
}

async function runCheck(work: () => Promise<HealthCheck>) {
  try {
    return await work()
  } catch (error) {
    return check('fail', Date.now(), errorText(error))
  }
}

async function checkDatabase() {
  const startedAt = Date.now()
  await databaseHealth()
  return check('pass', startedAt, 'Neon PostgreSQL is responding.')
}

async function checkPolygon() {
  const startedAt = Date.now()
  const [chainId, blockNumber, bytecode] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
    publicClient.getBytecode({ address: POLYGON_USDT_ADDRESS }),
  ])
  if (chainId !== POLYGON_CHAIN_ID) {
    throw new Error(`Polygon RPC returned chain ${chainId}, expected ${POLYGON_CHAIN_ID}.`)
  }
  if (!bytecode || bytecode === '0x') throw new Error('Configured Polygon USDT contract has no deployed bytecode.')
  return check('pass', startedAt, `Polygon chain ${chainId} is responding at block ${blockNumber.toString()}.`, {
    chainId,
    blockNumber: blockNumber.toString(),
  })
}

async function checkRelayer() {
  const startedAt = Date.now()
  if (!relayerAccount) throw new Error('Relayer private key is not configured with a valid format.')
  const [chainId, balance] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBalance({ address: relayerAccount.address }),
  ])
  if (chainId !== POLYGON_CHAIN_ID) {
    throw new Error(`Relayer RPC returned chain ${chainId}, expected ${POLYGON_CHAIN_ID}.`)
  }
  const lowBalance = balance < config.alertMinRelayerPolRaw
  return check(
    lowBalance ? 'degraded' : 'pass',
    startedAt,
    lowBalance ? 'Relayer POL is below the configured alert threshold.' : 'Relayer account and POL balance are ready.',
    {
      address: relayerAccount.address,
      balancePol: formatUnits(balance, 18),
      alertThresholdPol: formatUnits(config.alertMinRelayerPolRaw, 18),
    },
  )
}

async function checkNimiq() {
  const startedAt = Date.now()
  if (!config.nimVerificationEndpoint) throw new Error('NIM verification endpoint is not configured.')
  if (!config.nimRecipient) throw new Error('NIM payment recipient is not configured.')
  const account = await readNimiqAccount(config.nimVerificationEndpoint, config.nimRecipient)
  const balance = parseNimInteger(account.balance, 'NimFuel NIM balance')
  const lowBalance = balance < config.alertMinNimLuna
  return check(
    lowBalance ? 'degraded' : 'pass',
    startedAt,
    lowBalance ? 'NimFuel NIM balance is below the configured alert threshold.' : 'NIM verification endpoint and payment account are ready.',
    {
      balanceNim: formatUnits(balance, 5),
      alertThresholdNim: formatUnits(config.alertMinNimLuna, 5),
    },
  )
}

async function checkPricing() {
  const startedAt = Date.now()
  const prices = await readMarketPrices()
  const failedProviders = prices.providers.filter(provider => provider.status === 'fail').length
  const detail = prices.degraded
    ? 'Quotes are using a fallback or bounded recent price while one configured source is unavailable.'
    : 'Configured price sources returned safe NIM and POL prices.'
  return check(prices.degraded ? 'degraded' : 'pass', startedAt, detail, {
    nimProvider: prices.nim.provider,
    polProvider: prices.pol.provider,
    failedProviders,
    nimPriceRetrievedAt: prices.nim.retrievedAt,
    polPriceRetrievedAt: prices.pol.retrievedAt,
  })
}

async function buildSnapshot(): Promise<HealthSnapshot> {
  const [database, polygon, relayer, nim, pricing] = await Promise.all([
    runCheck(checkDatabase),
    runCheck(checkPolygon),
    runCheck(checkRelayer),
    runCheck(checkNimiq),
    runCheck(checkPricing),
  ])
  const checks = { database, polygon, relayer, nim, pricing }
  const status = Object.values(checks).reduce<MonitorStatus>(
    (current, item) => statusRank(item.status) > statusRank(current) ? item.status : current,
    'pass',
  )
  return {
    status,
    ready: status === 'pass',
    checkedAt: new Date().toISOString(),
    checks,
    alertsConfigured: Boolean(config.alertWebhookUrl),
    liveBroadcastEnabled: config.liveBroadcastEnabled,
    relaySafetyPaused: isRelaySafetyPaused(),
  }
}

export class SystemMonitor {
  private snapshot: HealthSnapshot | null = null
  private refreshInFlight: Promise<HealthSnapshot> | null = null
  private readonly lastAlertAt = new Map<string, number>()

  async refresh(force = false) {
    if (!force && this.snapshot && Date.now() - Date.parse(this.snapshot.checkedAt) < config.healthCacheSeconds * 1_000) {
      return this.snapshot
    }
    if (this.refreshInFlight) return await this.refreshInFlight

    const previous = this.snapshot
    this.refreshInFlight = buildSnapshot()
      .then(snapshot => {
        this.snapshot = snapshot
        this.emitHealthAlerts(previous, snapshot)
        return snapshot
      })
      .finally(() => {
        this.refreshInFlight = null
      })
    return await this.refreshInFlight
  }

  async current() {
    return await this.refresh(false)
  }

  publicSnapshot(snapshot: HealthSnapshot) {
    return {
      ok: snapshot.status !== 'fail',
      ready: snapshot.ready,
      status: snapshot.status,
      checkedAt: snapshot.checkedAt,
      liveBroadcastEnabled: snapshot.liveBroadcastEnabled,
      relaySafetyPaused: snapshot.relaySafetyPaused,
      alertsConfigured: snapshot.alertsConfigured,
      checks: Object.fromEntries(Object.entries(snapshot.checks).map(([key, item]) => [key, {
        status: item.status,
        latencyMs: item.latencyMs,
        detail: item.detail,
        checkedAt: item.checkedAt,
      }])),
    }
  }

  adminSnapshot(snapshot: HealthSnapshot) {
    return {
      ...this.publicSnapshot(snapshot),
      checks: snapshot.checks,
    }
  }

  async report(key: string, severity: 'warning' | 'critical', message: string, data: Record<string, unknown> = {}) {
    await this.sendAlert(key, severity, message, data)
  }

  private emitHealthAlerts(previous: HealthSnapshot | null, current: HealthSnapshot) {
    for (const [key, item] of Object.entries(current.checks)) {
      const previousItem = previous?.checks[key]
      if (item.status === 'pass') {
        if (previousItem && previousItem.status !== 'pass') {
          void this.sendAlert(`health:${key}:recovered`, 'warning', `${key} dependency recovered.`, { detail: item.detail })
        }
        continue
      }
      const severity = item.status === 'fail' ? 'critical' : 'warning'
      void this.sendAlert(`health:${key}:${item.status}`, severity, `${key} dependency is ${item.status}.`, { detail: item.detail })
    }
  }

  private async sendAlert(key: string, severity: 'warning' | 'critical', message: string, data: Record<string, unknown>) {
    const now = Date.now()
    const lastAlert = this.lastAlertAt.get(key) || 0
    if (now - lastAlert < config.alertCooldownSeconds * 1_000) return
    this.lastAlertAt.set(key, now)

    const payload = JSON.stringify({
      service: 'nimfuel-server',
      severity,
      message,
      occurredAt: new Date(now).toISOString(),
      data,
    })
    if (!config.alertWebhookUrl) {
      console.warn(`[nimfuel-alert:${severity}] ${message}`)
      return
    }

    try {
      const response = await fetch(config.alertWebhookUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) console.error(`Alert webhook returned HTTP ${response.status}.`)
    } catch (error) {
      console.error(`Alert webhook could not be reached: ${errorText(error)}`)
    }
  }
}

export const systemMonitor = new SystemMonitor()
