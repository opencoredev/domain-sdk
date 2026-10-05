---
subject: Add the Namecheap DNS provider
packages:
  "@opencoredev/domain-sdk": minor
---

## Namecheap DNS records

Added a `namecheap` adapter at `@opencoredev/domain-sdk/namecheap` for Namecheap BasicDNS. It supports routing and verification records, reports nameserver delegation, and serializes whole-zone replacements within an instance while preserving unrelated hosts and email settings.
