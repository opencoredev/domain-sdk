# @opencoredev/domain-sdk

Custom domains, handled. Add, verify, monitor, and remove customer domains with one TypeScript API. This package is server-side infrastructure; never expose provider credentials to a browser.

```bash
npm install @opencoredev/domain-sdk
```

Requires Node 20+ or Bun. The package is ESM-only and imports no Node built-ins, so it also loads in Cloudflare Workers, Vercel Edge, and Deno.

```ts
import { createDomainClient } from "@opencoredev/domain-sdk";
import { vercel } from "@opencoredev/domain-sdk/vercel";

const domains = createDomainClient({
  provider: vercel({
    token: process.env.VERCEL_TOKEN!,
    projectId: process.env.VERCEL_PROJECT_ID!,
    teamId: process.env.VERCEL_TEAM_ID,
  }),
});

const domain = await domains.add("app.customer.com");
```

Give tenants subdomains under a parent domain you own:

```ts
import { createSubdomainClient } from "@opencoredev/domain-sdk";

const subdomains = createSubdomainClient({
  domainClient: domains,
  baseDomain: "mydomain.com",
});

const hostname = subdomains.toHostname("customer"); // customer.mydomain.com
subdomains.toHostname("www"); // throws INVALID_HOSTNAME: www, api, admin, and mail are reserved

// Provision once when the selected adapter supports wildcards.
const wildcard = await subdomains.provisionWildcard();
```

Pass `reservedLabels` to replace the default reserved labels, for example `[...DEFAULT_RESERVED_LABELS, "billing"]`, or `[]` to reserve none. `subdomains.list()` pages through the tenant subdomains the provider already has.

Store the normalized label and hostname with the tenant in your own database. Configure the required DNS records returned by wildcard provisioning once; otherwise use `subdomains.add("customer")` to attach each hostname separately.

Switch providers by changing the adapter:

```ts
import { bunny } from "@opencoredev/domain-sdk/bunny";
import { cloudflareSaaS } from "@opencoredev/domain-sdk/cloudflare";
import { netlify } from "@opencoredev/domain-sdk/netlify";
import { railway } from "@opencoredev/domain-sdk/railway";
import { render } from "@opencoredev/domain-sdk/render";

const cloudflare = cloudflareSaaS({
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  zoneId: process.env.CLOUDFLARE_ZONE_ID!,
  cnameTarget: process.env.CLOUDFLARE_CNAME_TARGET!,
});

const railwayProvider = railway({
  token: process.env.RAILWAY_TOKEN!,
  projectId: process.env.RAILWAY_PROJECT_ID!,
  environmentId: process.env.RAILWAY_ENVIRONMENT_ID!,
  serviceId: process.env.RAILWAY_SERVICE_ID!,
});

const renderProvider = render({
  apiKey: process.env.RENDER_API_KEY!,
  serviceId: process.env.RENDER_SERVICE_ID!,
});

const netlifyProvider = netlify({
  accessToken: process.env.NETLIFY_ACCESS_TOKEN!,
  siteId: process.env.NETLIFY_SITE_ID!,
});

const bunnyProvider = bunny({
  apiKey: process.env.BUNNY_API_KEY!,
  pullZoneId: process.env.BUNNY_PULL_ZONE_ID!,
});
```

When the zone is at Porkbun, Namecheap, or Spaceship, write the required records with a DNS adapter:

```ts
import { createDnsClient } from "@opencoredev/domain-sdk";
import { porkbun } from "@opencoredev/domain-sdk/porkbun";

const dns = createDnsClient({
  provider: porkbun({
    apiKey: process.env.PORKBUN_API_KEY!,
    secretApiKey: process.env.PORKBUN_SECRET_API_KEY!,
  }),
});

const domain = await domains.add("app.customer.com");
await dns.applyDomainRecords(domain);
```

The DNS client lists the zone first, adds only missing records, and rejects conflicting records with `DOMAIN_CONFLICT` unless you pass `onConflict: "replace"`. Use `namecheap()` from `@opencoredev/domain-sdk/namecheap` or `spaceship()` from `@opencoredev/domain-sdk/spaceship` the same way.

The lifecycle is `add`, `get`/`refresh`, optional `verify`, `list`, `waitUntilActive`, and `remove`. Duplicate adds return the existing domain only when it belongs to the configured provider resource; conflicts are never silently moved.

```ts
import { DomainSdkError } from "@opencoredev/domain-sdk";

try {
  await domains.add("app.customer.com");
} catch (error) {
  if (error instanceof DomainSdkError) {
    console.error(error.code, error.retryable);
  }
}
```

Run the same lifecycle from a terminal or script with the `domain-sdk` CLI. It reads credentials from the environment variables above:

```bash
export VERCEL_TOKEN=... VERCEL_PROJECT_ID=...
npx @opencoredev/domain-sdk add app.customer.com --provider vercel   # prints the DNS records to configure
npx @opencoredev/domain-sdk wait app.customer.com --provider vercel --timeout-ms 600000
npx @opencoredev/domain-sdk list --provider vercel --json
```

Commands are `add`, `get`, `list`, `verify`, `remove`, and `wait`. `--json` prints machine-readable output. The exit code is 0 on success, 1 when the operation fails or an environment variable value is invalid (the error code is printed), and 2 for an invalid command line, unknown provider, or missing required environment variables.

Test without network access:

```ts
import { createDomainClient } from "@opencoredev/domain-sdk";
import { memoryProvider } from "@opencoredev/domain-sdk/testing";

const memory = memoryProvider();
const domains = createDomainClient({ provider: memory });
await domains.add("app.customer.com");
memory.activate("app.customer.com");
```

Full documentation: [domain-sdk.dev/docs](https://domain-sdk.dev/docs)
