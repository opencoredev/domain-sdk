---
subject: Add the bunny.net provider
packages:
  "@opencoredev/domain-sdk": minor
---

## bunny.net custom hostnames

Added a `bunny` adapter at `@opencoredev/domain-sdk/bunny` that manages the custom hostnames of one bunny.net CDN pull zone. It returns routing records pointed at the pull zone's own system hostname, supports apex and wildcard hostnames, and exposes `verify()` as a free-certificate request so a domain only reports as active once bunny.net has validated it.
