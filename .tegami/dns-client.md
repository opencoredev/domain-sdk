---
subject: Add a DNS client for writing hosting records into registrar zones
packages:
  "@opencoredev/domain-sdk": minor
---

`createDnsClient()` takes a `DnsProvider` adapter for a registrar or DNS host and writes the records a hosting provider returns. `ensureRecords()` only creates missing records and refuses to overwrite conflicting ones unless you pass `onConflict: "replace"`. `removeRecords()` deletes exact matches only, and `applyDomainRecords()` writes a `Domain`'s required records in one call. `memoryDnsProvider()` in `@opencoredev/domain-sdk/testing` backs tests.
