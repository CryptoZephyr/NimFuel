# NimFuel tasks

## Active operational state

Live relay broadcasting is enabled in production (`/health` reports `liveBroadcastEnabled: true`, `relaySafetyPaused: false`).

- [x] Add a backend-enforced safety pause for new quotes, orders, payment verification, and relay execution (`NIMFUEL_RELAY_SAFETY_PAUSE`).
- [x] Add a frontend notice while retaining safe wallet checks and historical views when the pause is active.
- [x] Preserve all existing orders, payment records, relay attempts, and transaction evidence.
- [x] Temporarily pause live relay broadcasting, automatic recovery, and refund queueing pending Nimiq's technical clarification.
- [x] Review the relay path and re-enable live relay broadcasting in production.
- [x] Require a wallet signature for order history access.
