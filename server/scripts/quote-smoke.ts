import { config } from '../src/config.js'
import { calculateNimQuote, readMarketPrices } from '../src/prices.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const prices = await readMarketPrices()
  assert(prices.nim.usdNanos > 0n && prices.pol.usdNanos > 0n, 'Live NIM and POL prices were not positive.')
  assert(prices.nim.tickerId === config.priceNimTickerId && prices.pol.tickerId === config.pricePolTickerId, 'The configured quote tickers were not used.')
  console.log('live price read: pass')

  const inputs = {
    polPriceUsdNanos: 100_000_000n,
    nimPriceUsdNanos: 1_000_000n,
    serviceFeeBps: 500,
    fixedServiceFeeLuna: 100n,
    minPaymentLuna: 1_000n,
  }
  const low = calculateNimQuote({ ...inputs, estimatedFeeRaw: 1n })
  const base = calculateNimQuote({ ...inputs, estimatedFeeRaw: 2n * 10n ** 18n })
  const higher = calculateNimQuote({ ...inputs, estimatedFeeRaw: 4n * 10n ** 18n })
  assert(low.paymentAmountLuna === inputs.minPaymentLuna, 'The minimum NIM payment floor was not applied.')
  assert(base.paymentAmountLuna > low.paymentAmountLuna, 'A real relay fee did not produce a billable NIM quote.')
  assert(higher.paymentAmountLuna > base.paymentAmountLuna, 'The NIM quote did not increase with the relay fee.')
  assert(base.serviceFeeLuna === inputs.fixedServiceFeeLuna, 'The fixed service fee was not retained in the quote.')
  console.log('quote calculation, minimum floor, and fee sensitivity: pass')
}

await main()
console.log('quote smoke: pass')
