# NimFuel handoff

## Temporary stablecoin relay safety pause

NimFuel is paused while Nimiq investigates a Stablecoin Gas Abstraction security issue involving OpenGSN.

- Production configuration: `NIMFUEL_ENABLE_LIVE_BROADCAST=false` and `NIMFUEL_RELAY_SAFETY_PAUSE=true`.
- User behavior: wallet and read-only checks remain available. New quotes, NIM payment orders, NIM payment verification, and relay execution are unavailable with a clear pause message.
- Historical state: orders, payment records, relay attempts, and completed transaction evidence are preserved. Existing paid and recovery-state orders remain stored for later operator review.
- Automation: relay recovery and refund queueing are paused. No new Polygon transactions or automatic NIM refunds are sent.
- Re-enable condition: Nimiq publishes technical clarification and NimFuel's relay path is reviewed against the affected mechanism.
