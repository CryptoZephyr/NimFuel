# NimFuel

NIM-funded Polygon gas for a USDT action inside Nimiq Pay.

NimFuel helps a Nimiq Pay wallet complete a Polygon USDT transfer when the wallet has USDT but does not have enough POL for gas. The wallet owner chooses the USDT amount and recipient. NimFuel reads the live Polygon fee, calculates the NIM quote, creates an order-specific payment reference, verifies the NIM payment independently, relays the signed USDT action with the relayer's POL, and verifies the Polygon receipt before reporting success.

## Product flow

1. Check the Nimiq Pay wallet, Polygon network, USDT balance, and POL balance.
2. Enter the recipient and the USDT amount. The amount is policy-driven, not fixed to a test value.
3. Review and sign the exact USDT authorization in the wallet.
4. Pay the exact NIM quote using the order-specific reference.
5. Verify the NIM payment, relay the paid action, and verify the Polygon receipt.

Paid orders persist through refreshes. A failed relay can be retried against the same paid order with a fresh authorization, subject to the configured retry cap. Recovery states preserve the order reference for safe support handling and refunds.

## Repository layout

- `app/` is the Vite frontend and Nimiq Pay mini-app surface.
- `server/` is the native Node API, relay worker, quote service, and durable order store.
- `DEPLOYMENT.md` documents the Neon and Render configuration.
- `.env.example` lists configuration names without values.

## Local setup

Use Node.js 20.19 or newer. Install dependencies in each package:

```text
cd server
npm ci

cd ../app
npm ci
```

Create `app/.env.local` and `server/.env` from the root `.env.example`, then fill the local values in each file. Environment files are ignored by Git. Keep the relayer private key and database URL on the server only.

Run the API and app in separate terminals:

```text
cd server
npm run dev
```

```text
cd app
npm run dev -- --host 0.0.0.0
```

The app expects the API at `http://localhost:3001` during local development.

## Verification

```text
npm --prefix app run build
npm --prefix server run build
npm --prefix server run test:quote
npm --prefix server run test:durable
```

The durable smoke test needs the server's local database and verification configuration. Build and test output is evidence for the local checkout only. It does not replace a live wallet flow, a Polygon receipt, or an independent Nimiq verification result.

## Deployment

The current hosted surfaces are:

- Frontend: <https://nimfuel-app.onrender.com>
- API: <https://nimfuel-backend.onrender.com>
- API health: <https://nimfuel-backend.onrender.com/health>

The API runs as a native Node service with Neon PostgreSQL. The frontend is a static Vite build. See [DEPLOYMENT.md](DEPLOYMENT.md) for the provider settings and live relay controls.

## Security boundaries

- The relayer private key stays in the server environment and is never sent to the browser.
- The browser signs the recipient, amount, token, chain context, nonce, and deadline through the Nimiq Pay provider.
- The server validates the signature and live token state before quoting or relaying.
- NIM payment is independently matched to the order before Polygon fulfillment is unlocked.
- Relay attempts are durable and capped. A failed order remains recoverable instead of silently charging again.
- Never commit `.env`, `.env.local`, private keys, API keys, database URLs, or wallet recovery material.

## License

MIT. See [LICENSE](LICENSE).
