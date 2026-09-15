# NimFuel environment map

NimFuel uses Neon for durable PostgreSQL storage.

## Environments

- `development` is the Neon branch for local and negative-path testing.
- `main` is the Neon branch reserved for the production-like lifecycle.
- The local server is currently linked to `main` through the ignored `.neon` file.

The Neon CLI pulls the pooled `DATABASE_URL` into the ignored `server/.env` file. Credentials must stay in local environment files or the deployment provider's secret store.

## Local files

- `app/.env.local` contains browser-safe `PUBLIC_` values and points the app to the local API.
- `server/.env` contains the Polygon RPC, relayer key, Nimiq verification settings, price API settings, and Neon connection string.
- Root `.env.example` contains variable names only.

## Live relay gate

The default local state is:

```text
NIMFUEL_ENABLE_LIVE_BROADCAST=false
NIMFUEL_LIVE_RELAY_MAX_ATTEMPTS=1
NIMFUEL_RELAY_RESERVATION_GRACE_SECONDS=60
NIMFUEL_QUOTE_TTL_SECONDS=300
NIMFUEL_SERVICE_FEE_BPS=0
NIMFUEL_MIN_PAYMENT_LUNA=1000
NIMFUEL_FIXED_SERVICE_FEE_LUNA=0
```

For a short approved production-like proof, set the live switch to `true`, set `NIMFUEL_LIVE_BROADCAST_TTL_SECONDS` to the required window, restart the server, confirm `/health` reports the live switch enabled, and run one already-paid order. The server disables new broadcasts automatically when the window expires. Set the live switch back to `false` after the receipt is independently verified.

## Quote and recovery API

- `POST /v1/preflight` validates the signed USDT action, reads live POL and NIM prices, and stores a short-lived quote.
- `POST /v1/orders` consumes a quote and creates one order-specific NIM payment reference.
- `POST /v1/orders/:id/verify-payment` independently verifies the NIM payment before fulfillment.
- `POST /v1/relay/execute` uses the stored authorization for a paid order, or accepts a fresh authorization for a failed retry.
- `GET /v1/admin/orders?orderId=...` and `GET /v1/admin/orders?reference=...` expose protected order and relay-attempt lookup when `ADMIN_API_TOKEN` is configured.
- `POST /v1/admin/orders/:id/refund` moves an eligible paid order to `REFUND_PENDING` and returns the exact manual refund instruction.
- `POST /v1/admin/orders/:id/refund/verify` independently verifies the refund transaction and records `REFUNDED`.

Refund sending remains an operator-controlled NIM transfer. The service records the instruction and only marks it refunded after the configured Nimiq verification endpoint confirms the recipient, amount, reference, sender when configured, and confirmation state.

## Render backend

The backend is deployed as a native Node service on Render.

- Service: `nimfuel-backend`
- URL: `https://nimfuel-backend.onrender.com`
- Runtime: native Node
- Region: Frankfurt
- Source: private `CryptoZephyr/NimFuel`, branch `main`
- Root directory: `server`
- Build command: `npm ci && npm run build`
- Start command: `node dist/index.js`
- Health endpoint: `/health`
- Storage: Neon PostgreSQL
- Live broadcast: disabled

Secrets are configured in Render's environment and are not committed. The public app still needs its own hosting configuration and must point `PUBLIC_API_BASE_URL` at the backend URL above.
