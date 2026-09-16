# Security policy

NimFuel handles wallet authorizations, NIM payments, and a server-side Polygon relayer. Treat the hosted deployment as a controlled demonstration until the operator has completed production monitoring, access controls, and an independent security review.

## Reporting a vulnerability

Please report suspected security issues privately to the repository owner through GitHub. Include the affected surface, reproduction steps, impact, and any transaction or order references that help investigation. Do not include private keys, seed phrases, API keys, database URLs, or other secrets in a report.

## Secret handling

Keep all environment files local or in the deployment provider's secret store. The relayer key must never be placed in frontend variables, source code, screenshots, issues, or commit history. Rotate any secret that may have been exposed and invalidate affected deployment credentials before further testing.

## Stage 2 controls

The API checks the database, Polygon RPC and USDT contract, relayer account, NIM verification rail, and pricing sources. Public health responses omit detailed account data. Detailed checks and aggregate metrics require `ADMIN_API_TOKEN`.

The price layer can use a fallback source and a bounded last-good cache. It rejects excessive source divergence and reports degraded quotes explicitly. A fallback price is a continuity measure, not a guarantee of market accuracy.

Origin checks and in-process fixed-window rate limits protect the native API from common accidental and low-volume abusive traffic. The in-process limiter resets when the service restarts, so a public production deployment should also use provider-level rate limiting and request filtering.

Automatic refund handling only queues eligible paid recovery orders. It never holds a private key for refund signing and never sends NIM automatically. Operators must follow the verification flow in `RUNBOOK.md`.
