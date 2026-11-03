---
subject: Fix Render wildcard DNS targets
packages:
  "@opencoredev/domain-sdk":
    type: patch
---

## Render wildcard DNS targets

The Render adapter now builds the `_acme-challenge` and `_cf-custom-hostname` CNAME targets for wildcard domains from the service's onrender.com subdomain (for example `svelte.verify.renderdns.com`), as Render's docs describe, instead of the service ID. If Render returns a service hostname outside onrender.com, wildcard lookups fail with `REQUEST_FAILED` rather than returning records that cannot work.
