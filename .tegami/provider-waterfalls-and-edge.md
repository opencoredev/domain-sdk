---
subject: Cut provider request waterfalls and drop the last Node built-in import
packages:
  "@opencoredev/domain-sdk": patch
---

## Fewer provider requests

- Cloudflare `get()` and `list()` normalize the custom hostnames returned by the lookup and page requests instead of fetching each hostname again by id.
- Render fetches the service hostname at most once per provider instance and retries it on the next call if the first fetch fails.
- Railway `list()` reads full domain details, including certificate status, from one GraphQL query.
- Vercel `list()` fetches domain configurations five at a time instead of one after another, keeping the original order.

## Edge runtimes

The Namecheap adapter validates `clientIp` with a built-in IPv4 check instead of `node:net`, so the SDK no longer imports any `node:*` module and loads in Cloudflare Workers, Vercel Edge, Deno, and Bun without Node compatibility flags.
