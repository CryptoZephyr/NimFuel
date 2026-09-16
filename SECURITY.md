# Security policy

NimFuel handles wallet authorizations, NIM payments, and a server-side Polygon relayer. Treat the hosted deployment as a controlled demonstration until the operator has completed production monitoring, access controls, and an independent security review.

## Reporting a vulnerability

Please report suspected security issues privately to the repository owner through GitHub. Include the affected surface, reproduction steps, impact, and any transaction or order references that help investigation. Do not include private keys, seed phrases, API keys, database URLs, or other secrets in a report.

## Secret handling

Keep all environment files local or in the deployment provider's secret store. The relayer key must never be placed in frontend variables, source code, screenshots, issues, or commit history. Rotate any secret that may have been exposed and invalidate affected deployment credentials before further testing.
