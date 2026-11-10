---
subject: Support Railway project tokens
packages:
  "@opencoredev/domain-sdk":
    type: patch
---

## Railway project tokens

The Railway adapter takes an optional `tokenType` option. Set `tokenType: "project"` to authenticate with a Railway project token: every request then sends the `Project-Access-Token` header and no `Authorization` header. The default, `"bearer"`, keeps sending `Authorization: Bearer <token>` for account and workspace tokens. Any other value throws `INVALID_CONFIGURATION`. Error redaction now also hides `Project-Access-Token` header values.
