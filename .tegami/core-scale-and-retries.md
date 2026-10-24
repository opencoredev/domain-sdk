---
subject: Retry transient provider failures and stop truncating large responses
packages:
  "@opencoredev/domain-sdk": minor
---

## Retries, polling backoff, and pluggable DNS locks

- Provider responses larger than 16 KB now parse correctly. Previously the body was cut at 16,000 characters before parsing and failed with `REQUEST_FAILED` ("The provider returned malformed JSON").
- `createDomainClient()` and `createDnsClient()` retry rate limits (429) and transient outages (502, 503, 504, and network failures) up to 3 attempts. They wait the provider's `Retry-After` when it sends one, otherwise exponential backoff with full jitter, and never wait longer than `maxDelayMs` at a time. Tune or disable it with `retry: { maxAttempts, baseDelayMs, maxDelayMs }`; `{ maxAttempts: 1 }` turns retries off. A DNS replacement that failed and was rolled back is not retried.
- `waitUntilActive()` backs off between polls: it starts at `intervalMs` (5s), multiplies by `backoffFactor` (1.5) after each poll, and stops growing at `maxIntervalMs` (30s). Pass `backoffFactor: 1` for the old fixed interval and `jitter: true` to spread polls from many workers.
- `createDnsClient({ lock })` accepts a per-zone lock such as Redis or Postgres, so several workers or serverless instances can write to one zone without racing. Without it, the client keeps its in-memory per-zone queue.
