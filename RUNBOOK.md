# NimFuel operations runbook

This runbook covers the current native Node API and static Vite app. It assumes Neon PostgreSQL, Polygon, Nimiq verification, and a server-side relayer. The relayer private key, database URL, API keys, and alert webhook stay in the deployment provider or ignored local files.

## Local start

Use Node.js 20.19 or newer. Install dependencies once in `server` and `app`, then run the services in separate terminals:

```text
cd server
npm ci
npm run dev
```

```text
cd app
npm ci
npm run dev -- --host 0.0.0.0
```

The app uses `PUBLIC_API_BASE_URL` and the API listens on port 3001 by default. The app and server environment files are ignored by Git.

## Stage 2 environment

Required existing values remain the same:

- `POLYGON_RPC_URL`, `POLYGON_RELAYER_PRIVATE_KEY`, `DATABASE_URL`
- `NIMIQ_RPC_OR_VERIFICATION_ENDPOINT`, `NIMFUEL_NIM_RECIPIENT`
- `PRICE_API_URL`, with `PRICE_NIM_TICKER_ID` and `PRICE_POL_TICKER_ID` when the provider needs explicit ticker IDs

Stage 2 adds these controls:

- `PRICE_FALLBACK_API_URL`, `PRICE_FALLBACK_API_KEY`: optional second CoinPaprika-compatible source.
- `PRICE_MAX_DEVIATION_BPS`: maximum allowed difference between successful sources. Quotes stop when sources disagree beyond this threshold.
- `PRICE_MAX_AGE_SECONDS`: maximum age for the in-memory last-good price when every source is temporarily unavailable.
- `NIMFUEL_ALERT_MIN_RELAYER_POL`, `NIMFUEL_ALERT_MIN_NIM`: low-balance warning thresholds.
- `NIMFUEL_ALERT_WEBHOOK_URL`: optional alert destination. The URL is never returned by the API.
- `NIMFUEL_ALERT_COOLDOWN_SECONDS`: repeated-alert cooldown.
- `NIMFUEL_MONITOR_INTERVAL_SECONDS`, `NIMFUEL_HEALTH_CACHE_SECONDS`: monitoring cadence and public health cache.
- `NIMFUEL_RECOVERY_SCAN_INTERVAL_SECONDS`: relay recovery and optional refund-queue scan cadence.
- `NIMFUEL_RELAY_RECEIPT_TIMEOUT_SECONDS`: how long a relay request waits for Polygon receipt inclusion before returning a pending state.
- `NIMFUEL_AUTO_REFUND_AFTER_SECONDS`: optional age threshold for queueing eligible paid recovery orders. It does not sign or send a refund.
- `NIMFUEL_RATE_LIMIT_WINDOW_SECONDS`, `NIMFUEL_RATE_LIMIT_REQUESTS_PER_WINDOW`: general fixed-window API limits.
- `NIMFUEL_RATE_LIMIT_PREPARE_PER_WINDOW`, `NIMFUEL_RATE_LIMIT_ORDER_PER_WINDOW`, `NIMFUEL_RATE_LIMIT_RELAY_PER_WINDOW`: tighter limits for quote, order, and relay work.
- `NIMFUEL_ALLOWED_ORIGINS`: comma-separated frontend origins, or `*` for a local setup.
- `NIMFUEL_HISTORY_LIMIT`: maximum history rows returned for one address.

For persistent live operation, set `NIMFUEL_ENABLE_LIVE_BROADCAST=true` and leave `NIMFUEL_LIVE_BROADCAST_TTL_SECONDS` empty. Keep `NIMFUEL_LIVE_PROOF_AMOUNT_USDT` empty for flexible amounts. Set it only for an explicitly controlled proof window.

## Health and metrics

- `GET /health` returns the public status, readiness, live-broadcast flag, and dependency check summaries.
- `GET /v1/admin/health` returns the same snapshot with detailed check data and requires `Authorization: Bearer <ADMIN_API_TOKEN>`.
- `GET /v1/admin/metrics` returns aggregate order and relay counts, gas totals, and the last order activity time. It also requires the admin token.
- `GET /v1/orders?evmAddress=<address>&limit=<n>` returns a small public history summary for that connected address.

Treat `status=degraded` as a warning and `ready=false` as a deployment gate. A `200` response does not mean every dependency is healthy.

## Common incidents

### Pricing source is degraded

Check `/health` for the pricing detail and provider status. If a fallback or bounded recent price is active, new quotes carry a protected-price indicator. If no safe price is available, quote creation stops. Restore a configured provider or wait for the provider to recover. Do not bypass divergence protection by changing prices ad hoc.

### Relayer POL is low

Check the relayer balance in the deployment provider or the protected admin health endpoint. Fund the configured relayer account through the normal operator process, then confirm that the health check returns `pass`. Never place the relayer key in the browser environment.

### A relay is pending or needs recovery

Use the order ID or exact reference with the protected admin order endpoint. Reconcile a submitted transaction before authorizing another one. A failed relay can use a fresh authorization on the same paid order, up to the configured retry cap. `RECOVERY_REQUIRED` needs operator review.

### A paid order needs a refund

The optional automation only queues a paid recovery order. Use the protected refund endpoint to create the exact refund instruction, send the NIM transfer through the approved operator wallet, then use the verification endpoint with the resulting transaction hash. The order is marked `REFUNDED` only after the NIM verifier confirms the recipient, amount, reference, sender when configured, and confirmation state.

### Frontend reports that the API cannot be reached

Check the backend service, `/health`, `PUBLIC_API_BASE_URL`, the configured allowed origin, and the browser's network path. A local browser on a phone cannot resolve a computer's `localhost`, so use the computer's reachable LAN address for the local app when needed.

### Order history is missing or returns 404

Confirm the frontend and backend were deployed from the same commit. The history UI calls `GET /v1/orders?evmAddress=<address>&limit=<n>`. A `404` from that route means the backend is older than the frontend or is pointed at the wrong service. Redeploy the native backend, check `/health`, then use the history retry control. A valid `200` response with an empty list means the connected Polygon address has no orders in that database.

## Native deployment

The current Render shape is native Node for `server` and static Vite for `app`.

- Backend build: `npm ci && npm run build`
- Backend start: `node dist/index.js`
- Frontend build: `npm ci && npm run build`
- No Dockerfile or container step is required by this repository.

After a deployment, check the hosted API health response, load the hosted frontend in a clean browser session, and perform a small user-authorized flow. Keep local test output separate from hosted and Mainnet evidence.

## Release checklist

1. Confirm the working tree contains no real environment files, private keys, API keys, or database URLs.
2. Run the app and server builds, `npm run test:quote`, `npm run test:durable`, and `npm run test:stage2`.
3. Review `git diff --check` and the staged file list.
4. Push only the intended commit and verify the remote branch.
5. Confirm the provider redeployed the pushed commit before asking a user to test the hosted app.
