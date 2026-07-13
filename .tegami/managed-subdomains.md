---
subject: Add managed tenant subdomains
packages:
  "@opencoredev/domain-sdk": minor
---

## Managed tenant subdomains

Added `createSubdomainClient` for safely constraining customer-chosen labels to a parent domain owned by the application. It supports per-hostname lifecycle operations, reserved labels, direct-child boundary validation, and one-time wildcard provisioning when the selected provider exposes wildcard domains.
