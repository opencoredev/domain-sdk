---
subject: Harden polling, DNS writes, and errors; add a CLI and an operation hook
packages:
  "@opencoredev/domain-sdk":
    type: minor
---

## Behavior changes

- `waitUntilActive()` stops as soon as the provider reports `failed` and rejects with `VERIFICATION_FAILED` (status and issues in `details`) instead of polling until `TIMEOUT`. Pass `shouldStop` to also stop on `misconfigured`, or `() => false` for the old behavior.
- `ensureRecords()` and `applyDomainRecords()` re-read the zone after writing, roll back failed replacements, failed whole-zone writes, and failed per-record add-only writes (preserving the original error code such as `REQUEST_FAILED`, `RATE_LIMITED`, or `PROVIDER_UNAVAILABLE` with `details.restored`, `details.replaced`, `details.externalChange` when records outside the SDK's own writes changed concurrently or an unrequested record appeared at a target key, and `details.unexpected` when unrequested records remain at target keys; on per-record hosts, accepted add-only writes that fail post-write verification without collateral loss throw the verification error without rollback), and on whole-zone hosts restore dropped pre-write editable records after accepted/committed writes while leaving concurrent foreign additions and pre-commit external deletions untouched and vetoing automatic retries when external changes occur (whole-zone adapters set `details.committed: true` on write errors that already mutated the remote zone so rollback restores dropped editable records and flags unrequested same-key records in `details.unexpected` with `restored: false`). Cleanly rolled-back add-only failures without external changes remain retryable; rolled-back replacements are not automatically retried. Core post-write verification and Namecheap committed retention failures report `details.missing` / `details.remaining` / `details.collateralMissing` (any unrelated existing records, editable or locked, dropped by a whole-zone write).
- `createSubdomainClient()` reserves `www`, `api`, `admin`, and `mail` by default. A `reservedLabels` list replaces the defaults; pass `[]` to reserve none or `[...DEFAULT_RESERVED_LABELS, "billing"]` to extend them.
- Every async client method rejects its promise instead of throwing synchronously, including `list()` and `verify()` on unsupported providers and invalid hostnames (the synchronous `SubdomainClient.toHostname()` and `fromHostname()` helpers still throw synchronously).
- A `list()` limit outside 1 to 100 and invalid `waitUntilActive()` options reject with `INVALID_CONFIGURATION` instead of `REQUEST_FAILED`. Creating a client in a browser throws a `DomainSdkError` with `INVALID_CONFIGURATION` instead of a plain `Error`.
- Provider JSON responses are capped at 8 MiB (16 MiB for Porkbun and Spaceship responses), and Namecheap XML responses are capped at 1 MiB, failing with `REQUEST_FAILED` instead of being buffered without limit.

## Fixes

- `add({ hostname }, { signal })` now honors the signal in the second argument.
- Netlify `add()` and `remove()` run one at a time per provider instance, so concurrent calls no longer overwrite each other's aliases.
- Spaceship `listRecords()` starts over when `total` shifts or a record from an earlier page reappears on a later page instead of failing or returning a skewed offset snapshot.
- Error redaction hides `AccessKey` (bunny.net) and `access_token` values, and a wrapped cause keeps its name, stack frames, `code`, and nested `cause` chain with messages redacted.

## New

- A `domain-sdk` CLI with `add`, `get`, `list`, `verify`, `remove`, and `wait`, configured by `--provider` and the adapters' environment variables, with `--json` output.
- `onOperation` on `createDomainClient()` and `createDnsClient()` reports each finished call's operation, provider, duration, attempts, and outcome.
- `SubdomainClient.list()` returns the tenant subdomains on one provider page.
- The DNS record helpers `normalizeZone`, `normalizeRecordName`, `relativeRecordName`, `absoluteRecordName`, `canonicalRecordValue`, `parseCaaValue`, `formatCaaValue`, and `sameRecord` are exported for adapter authors.
- `render({ apexAddress })` overrides the apex A record address, which defaults to `216.24.57.1`.
- Every export has a `default` condition, and `@opencoredev/domain-sdk/package.json` is exported.
