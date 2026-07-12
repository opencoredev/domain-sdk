# @opencoredev/domain-sdk

Custom domains, handled. Add, verify, monitor, and remove customer domains with one TypeScript API. This package is server-side infrastructure; never expose provider credentials to a browser.

```bash
bun add @opencoredev/domain-sdk
```

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

Switch providers by changing the adapter:

```ts
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
```

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
