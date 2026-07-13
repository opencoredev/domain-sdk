## @opencoredev/domain-sdk@0.2.0

### Add managed tenant subdomains

#### Managed tenant subdomains

Added `createSubdomainClient` for safely constraining customer-chosen labels to a parent domain owned by the application. It supports per-hostname lifecycle operations, reserved labels, direct-child boundary validation, and one-time wildcard provisioning when the selected provider exposes wildcard domains.

## @opencoredev/domain-sdk@0.1.0

### Initial release

Add a provider-neutral TypeScript SDK for managing custom domains across Vercel, Cloudflare for SaaS, Railway, Render, and Netlify.
