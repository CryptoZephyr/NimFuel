# NimFuel roadmap

Updated 2026-09-16.

## Product boundary

NimFuel helps a Nimiq Pay user complete a Polygon USDT action when the wallet has USDT but lacks the POL needed for gas. The user chooses the recipient and amount, pays the quoted NIM service amount, and receives a verified Polygon result.

The DEX, USDT-to-NIM, and broader onboarding ideas remain on hold. They belong to later product decisions and are not part of the Stage 2 implementation below.

## Current status

| Stage | Position | Evidence boundary |
| --- | --- | --- |
| Stage 0, ground truth | Complete | Nimiq Pay, Polygon, USDT, and provider assumptions are recorded in the canonical Notion docs. |
| Stage 1, Cycle II core | Complete for the implemented flow | Local regression coverage and prior hosted paid-to-relay proof cover the current core. A hosted deployment must still be checked after every new release. |
| Stage 2, reliability productization | Implemented and hosted backend redeployed | Native build, quote, durable, and Stage 2 smoke checks pass locally. Hosted `/health` and address-scoped history now return the Stage 2 contract. A clean mobile wallet lifecycle remains user verification evidence. |

## Current hosted evidence

The native Render backend was redeployed from commit `080ce63`. Public `/health` returns `status=pass`, `ready=true`, Neon PostgreSQL storage, and the five dependency checks. The public address-scoped history route returns `200` with durable records. This confirms the service release and history API, but it does not replace a new user-authorized Nimiq Pay relay proof.

## Stage 2 delivered

- Active health checks for Neon PostgreSQL, Polygon, the relayer, the NIM verification rail, and pricing.
- Optional webhook alerts with cooldowns for dependency failures, low relayer POL, low NIM balance, and recovery events.
- Primary and fallback market-price sources with divergence protection, conservative selection, and a bounded recent-price cache.
- Durable order history for a connected Polygon address, with current order state and public transaction references.
- Operational metrics behind the admin bearer-token boundary.
- Configurable retry and API limits, request body protection, and configurable allowed origins.
- Recovery scanning remains durable. Optional automatic refund queueing moves eligible paid recovery orders to `REFUND_PENDING`, while refund sending stays operator-controlled.
- A native Node operations runbook and a repository roadmap that state the local, hosted, and proof boundaries.

## Stage 2 operator completion

1. Set the Stage 2 environment values in the deployment provider, including a fallback price source, allowed frontend origin, alert thresholds, and optional webhook.
2. Keep the native Node service deployed from the pushed `main` commit and verify its deployment record after each code change. The current backend redeploy is live from `080ce63`.
3. Check `/health` and the protected admin health and metrics endpoints. Public health and history checks are currently passing.
4. Run a clean mobile Nimiq Pay flow with a user-selected amount, then reload and confirm the order appears in history.
5. Keep the current live broadcast policy explicit. Leave the broadcast TTL empty only when persistent live operation is intentional.

## Later stages

- Stage 3, evaluate NIM-funded native gas-token refuel only if it improves the user experience enough to justify inventory, pricing, and custody risk.
- Stage 4, build Base Smart Deposit onboarding after a real, recoverable LI.FI route and destination proof exist.
- Stage 5, repeat the gas-enablement analysis for additional chains only after two real chains prove the pattern.
- Stage 6, consider asset rescue after gas enablement is reliable.
- Stage 7, add handoff APIs for other Nimiq Pay Mini Apps after the consumer flow is proven.

Each later stage needs its own real integration proof. Passing local tests does not prove a hosted deployment, a wallet flow, or a Mainnet transaction.
