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
```

For a short approved production-like proof, set the live switch to `true`, set `NIMFUEL_LIVE_BROADCAST_TTL_SECONDS` to the required window, restart the server, confirm `/health` reports the live switch enabled, and run one already-paid order. The server disables new broadcasts automatically when the window expires. Set the live switch back to `false` after the receipt is independently verified.

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
