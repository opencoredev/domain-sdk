## @opencoredev/domain-sdk@0.3.0

### Add the bunny.net provider

#### bunny.net custom hostnames

Added a `bunny` adapter at `@opencoredev/domain-sdk/bunny` that manages the custom hostnames of one bunny.net CDN pull zone. It returns routing records pointed at the pull zone's own system hostname, supports apex and wildcard hostnames, and exposes `verify()` as a free-certificate request so a domain only reports as active once bunny.net has validated it.

### Retry transient provider failures and stop truncating large responses

#### Retries, polling backoff, and pluggable DNS locks

- Provider responses larger than 16 KB now parse correctly. Previously the body was cut at 16,000 characters before parsing and failed with `REQUEST_FAILED` ("The provider returned malformed JSON").
- `createDomainClient()` and `createDnsClient()` retry rate limits (429) and transient outages (502, 503, 504, and network failures) up to 3 attempts. They wait the provider's `Retry-After` when it sends one, otherwise exponential backoff with full jitter, and never wait longer than `maxDelayMs` at a time. Tune or disable it with `retry: { maxAttempts, baseDelayMs, maxDelayMs }`; `{ maxAttempts: 1 }` turns retries off. A DNS replacement that failed and was rolled back is not retried.
- `waitUntilActive()` backs off between polls: it starts at `intervalMs` (5s), multiplies by `backoffFactor` (1.5) after each poll, and stops growing at `maxIntervalMs` (30s). Pass `backoffFactor: 1` for the old fixed interval and `jitter: true` to spread polls from many workers.
- `createDnsClient({ lock })` accepts a per-zone lock such as Redis or Postgres, so several workers or serverless instances can write to one zone without racing. Without it, the client keeps its in-memory per-zone queue.

### Add a DNS client for writing hosting records into registrar zones

#### DNS client for registrar zones

`createDnsClient()` takes a `DnsProvider` adapter for a registrar or DNS host and writes the records a hosting provider returns. `ensureRecords()` only creates missing records and refuses to overwrite conflicting ones unless you pass `onConflict: "replace"`. `removeRecords()` deletes exact matches only, and `applyDomainRecords()` writes a `Domain`'s required records in one call. `memoryDnsProvider()` in `@opencoredev/domain-sdk/testing` backs tests.

### Add the Namecheap DNS provider

#### Namecheap DNS records

Added a `namecheap` adapter at `@opencoredev/domain-sdk/namecheap` for Namecheap BasicDNS. It supports routing and verification records, reports nameserver delegation, and serializes whole-zone replacements within an instance while preserving unrelated hosts and email settings.

### Add the Porkbun DNS provider

#### Porkbun DNS records

Added a `porkbun` DNS adapter at `@opencoredev/domain-sdk/porkbun` for listing, creating, and deleting individual zone records. It supports A, AAAA, CNAME, ALIAS, TXT, and CAA records, checks nameserver delegation, and works with `createDnsClient().applyDomainRecords()` to apply a hosting provider's routing and verification records.

### Cut provider request waterfalls and drop the last Node built-in import

#### Fewer provider requests

- Cloudflare `get()` and `list()` normalize the custom hostnames returned by the lookup and page requests instead of fetching each hostname again by id.
- Render fetches the service hostname at most once per provider instance and retries it on the next call if the first fetch fails.
- Railway `list()` reads full domain details, including certificate status, from one GraphQL query.
- Vercel `list()` fetches domain configurations five at a time instead of one after another, keeping the original order.

#### Edge runtimes

The Namecheap adapter validates `clientIp` with a built-in IPv4 check instead of `node:net`, so the SDK no longer imports any `node:*` module and loads in Cloudflare Workers, Vercel Edge, Deno, and Bun without Node compatibility flags.

### Add the Spaceship DNS provider

#### Spaceship DNS records

Added a `spaceship` DNS adapter at `@opencoredev/domain-sdk/spaceship` for routing and verification records. It supports paginated listing, targeted saves and deletes, A, AAAA, CNAME, ALIAS, TXT, and CAA writes, managed-record protection, and nameserver delegation reporting through `createDnsClient`.

## @opencoredev/domain-sdk@0.2.0

### Add managed tenant subdomains

#### Managed tenant subdomains

Added `createSubdomainClient` for safely constraining customer-chosen labels to a parent domain owned by the application. It supports per-hostname lifecycle operations, reserved labels, direct-child boundary validation, and one-time wildcard provisioning when the selected provider exposes wildcard domains.

## @opencoredev/domain-sdk@0.1.0

### Initial release

Add a provider-neutral TypeScript SDK for managing custom domains across Vercel, Cloudflare for SaaS, Railway, Render, and Netlify.
