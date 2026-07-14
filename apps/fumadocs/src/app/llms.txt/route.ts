import { llms } from "fumadocs-core/source";

import { source } from "@/lib/source";

export const revalidate = false;

export function GET() {
  const documentation = llms(source)
    .index()
    .replace(/^# Domain SDK\s*/, "");
  const content = `# Domain SDK

> Add, verify, monitor, and remove customer domains across Vercel, Cloudflare for SaaS, Railway, Render, and Netlify with one server-side TypeScript API.

## Agent resources

- [Complete documentation](https://domain-sdk.dev/llms-full.txt): All documentation in one file.
- [Human-readable sitemap](https://domain-sdk.dev/sitemap): Every canonical documentation page grouped by topic.
- [Install the Domain SDK skill](https://github.com/opencoredev/domain-sdk/tree/main/skills/domain-sdk): \`npx skills add opencoredev/domain-sdk --skill domain-sdk\`
- [Source code](https://github.com/opencoredev/domain-sdk): Package source, providers, tests, and examples.

## Product facts

- Package: \`@opencoredev/domain-sdk\`
- License: MIT
- Runtime: Server-side Node.js 20+ or Bun
- Language: TypeScript
- Providers: Vercel, Cloudflare for SaaS, Railway, Render, and Netlify
- Cost: The open-source SDK is free; infrastructure provider charges are separate.
- Scope: Domain SDK manages domain lifecycle calls and normalized DNS instructions. It does not register domains, host DNS, proxy traffic, or store tenant data.

## Documentation

${documentation}`;

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": "noindex",
    },
  });
}
