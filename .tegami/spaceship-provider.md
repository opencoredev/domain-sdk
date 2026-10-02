---
subject: Add the Spaceship DNS provider
packages:
  "@opencoredev/domain-sdk": minor
---

## Spaceship DNS records

Added a `spaceship` DNS adapter at `@opencoredev/domain-sdk/spaceship` for routing and verification records. It supports paginated listing, targeted saves and deletes, A, AAAA, CNAME, ALIAS, TXT, and CAA writes, managed-record protection, and nameserver delegation reporting through `createDnsClient`.
