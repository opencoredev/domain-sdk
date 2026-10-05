---
subject: Add the Porkbun DNS provider
packages:
  "@opencoredev/domain-sdk": minor
---

## Porkbun DNS records

Added a `porkbun` DNS adapter at `@opencoredev/domain-sdk/porkbun` for listing, creating, and deleting individual zone records. It supports A, AAAA, CNAME, ALIAS, TXT, and CAA records, checks nameserver delegation, and works with `createDnsClient().applyDomainRecords()` to apply a hosting provider's routing and verification records.
