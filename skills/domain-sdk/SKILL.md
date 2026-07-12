---
name: domain-sdk
description: This skill should be used when the user asks to "add custom domains", "manage customer domains", "integrate Domain SDK", "set up Vercel domains", "set up Cloudflare custom hostnames", "set up Railway domains", "set up Render domains", "set up Netlify domain aliases", "show DNS records", "verify a customer domain", or "test domain flows without network calls" in a TypeScript application.
version: 0.1.0
---

# Domain SDK

Use `@opencoredev/domain-sdk` to add, inspect, verify, monitor, and remove customer domains through one provider-neutral TypeScript API. Keep all Domain SDK code on the server and preserve the provider as the source of truth for domain readiness.

## Start with current documentation

Read [https://domain-sdk.dev/llms.txt](https://domain-sdk.dev/llms.txt) to locate the relevant guide. Read [https://domain-sdk.dev/llms-full.txt](https://domain-sdk.dev/llms-full.txt) when exact provider behavior, credentials, status semantics, or API signatures are needed.

Inspect the installed package version and the application's existing server architecture before editing. Follow the package manager, environment-variable conventions, error handling, and testing patterns already used by the application.

## Choose the provider that owns traffic

Select the adapter for the platform that currently receives application traffic:

| Platform            | Import                               | Scope                                 |
| ------------------- | ------------------------------------ | ------------------------------------- |
| Vercel              | `@opencoredev/domain-sdk/vercel`     | One project, optionally within a team |
| Cloudflare for SaaS | `@opencoredev/domain-sdk/cloudflare` | Custom Hostnames in one SaaS zone     |
| Railway             | `@opencoredev/domain-sdk/railway`    | One project, environment, and service |
| Render              | `@opencoredev/domain-sdk/render`     | One web service or static site        |
| Netlify             | `@opencoredev/domain-sdk/netlify`    | Domain aliases on one existing site   |

Do not use the Cloudflare adapter for generic DNS record management. Do not choose a provider based only on where DNS is hosted; choose the platform that attaches the hostname to the deployed application.

## Install and create a server-only client

Install the package with the application's package manager:

```bash
bun add @opencoredev/domain-sdk
```

Create one client in a server-only module and reuse it. Keep provider tokens and resource IDs out of browser bundles, public environment variables, logs, and API responses.

```ts
import { createDomainClient } from "@opencoredev/domain-sdk";
import { vercel } from "@opencoredev/domain-sdk/vercel";

export const domains = createDomainClient({
  provider: vercel({
    token: process.env.VERCEL_TOKEN!,
    projectId: process.env.VERCEL_PROJECT_ID!,
    teamId: process.env.VERCEL_TEAM_ID,
  }),
});
```

Read the selected provider guide before finalizing configuration. Use the exact required identifiers and credential scopes documented there.

## Implement the domain lifecycle

Use the normalized lifecycle rather than calling provider APIs alongside Domain SDK:

1. Call `add(hostname)` to attach a customer hostname.
2. Return every record with `required: true` to the customer as DNS instructions.
3. Persist tenant ownership of the normalized hostname in the application database.
4. Call `get(hostname)` or `refresh(hostname)` to obtain provider-authoritative state.
5. Call `verify(hostname)` only when the selected provider exposes an explicit verification action.
6. Call `waitUntilActive(hostname, options)` only in a background job or bounded server operation.
7. Call `remove(hostname)` after authorizing the tenant and confirming destructive intent.

```ts
const domain = await domains.add("app.customer.com");
const requiredRecords = domain.records.filter((record) => record.required);

const latest = await domains.refresh(domain.hostname);
if (latest.status === "active") {
  // The provider now reports the hostname as ready.
}
```

Treat returned records as structured instructions. Preserve `type`, `name`, `value`, `purpose`, and `required`; do not collapse routing, ownership, and certificate records into a single guessed record.

## Preserve tenant and security boundaries

Authorize every read, refresh, verify, wait, and remove operation against the application's own hostname-to-tenant mapping. Domain SDK is stateless and does not establish tenant ownership.

Reject attempts to operate on a hostname owned by another tenant. Preserve duplicate-domain conflicts instead of silently moving domains between provider resources. Avoid reporting a domain as active from DNS lookup results alone; use normalized provider status.

Handle `DomainSdkError` without returning provider credentials or raw upstream payloads:

```ts
import { DomainSdkError } from "@opencoredev/domain-sdk";

try {
  await domains.add(hostname);
} catch (error) {
  if (error instanceof DomainSdkError) {
    logger.warn({ code: error.code, retryable: error.retryable });
  }
  throw error;
}
```

Use `retryable` to decide whether background work may retry. Bound polling with a timeout and propagate cancellation from the surrounding request or job.

## Test without provider credentials

Use the isolated memory provider for unit and integration tests:

```ts
import { createDomainClient } from "@opencoredev/domain-sdk";
import { memoryProvider } from "@opencoredev/domain-sdk/testing";

const memory = memoryProvider();
const domains = createDomainClient({ provider: memory });

await domains.add("app.customer.com");
memory.activate("app.customer.com");
```

Test tenant authorization in the application layer separately from provider behavior. Cover duplicate adds, required DNS records, pending-to-active transitions, timeouts, cancellation, provider errors, and idempotent removal.

## Validate the integration

Run the application's formatter, linter, type checker, and focused tests. Confirm that no provider secret enters client code. Confirm that all documented subpath imports resolve from the installed package version. Verify production behavior with a disposable hostname before enabling the flow for customers.
