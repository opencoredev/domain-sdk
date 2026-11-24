import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "blume";
import { posthog, script } from "blume/analytics";
import { vercel } from "blume/deploy";

import { domainSite } from "./integrations/site";

type Redirect = NonNullable<Parameters<typeof defineConfig>[0]["redirects"]>[number];

const legacyDocRedirects: Redirect[] = [
  { from: "/opengraph-image", to: "/opengraph-image.png", status: 308 },
  { from: "/twitter-image", to: "/opengraph-image.png", status: 308 },
  { from: "/docs/quickstart", to: "/docs/installation", status: 308 },
  { from: "/docs/how-it-works", to: "/docs/providers", status: 308 },
  { from: "/docs/providers/compatibility", to: "/docs/providers", status: 308 },
  { from: "/docs/project/provider-adapter-guide", to: "/docs/project/contributing", status: 308 },
  { from: "/docs/project/sponsorships", to: "/docs/project/contributing", status: 308 },
];

const docsContentRoot = fileURLToPath(new URL("./content/docs", import.meta.url));

// Preserve the Fumadocs /llms.mdx/docs/**/content.md URLs by redirecting each
// one to Blume's canonical .md URL.
const legacyMarkdownRedirects: Redirect[] = [
  ...readdirSync(docsContentRoot, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".mdx"))
    .sort()
    .map((entry): Redirect => {
      const normalized = entry.replace(/\\/g, "/");
      if (normalized === "index.mdx") {
        return { from: "/llms.mdx/docs/content.md", to: "/docs.md", status: 308 };
      }
      const slug = normalized.endsWith("/index.mdx")
        ? normalized.slice(0, -"/index.mdx".length)
        : normalized.slice(0, -".mdx".length);
      return {
        from: `/llms.mdx/docs/${slug}/content.md`,
        to: `/docs/${slug}.md`,
        status: 308,
      };
    }),
  ...legacyDocRedirects
    .filter((entry) => entry.from.startsWith("/docs/"))
    .map((entry): Redirect => {
      const fromSlug = entry.from.replace(/^\/docs\//, "");
      return {
        from: `/llms.mdx/docs/${fromSlug}/content.md`,
        to: `${entry.to}.md`,
        status: 308,
      };
    }),
];

// The production origin. Vercel sets VERCEL_PROJECT_PRODUCTION_URL to the
// project's production domain, so llms.txt, the sitemap, canonicals, and the
// MCP server follow it without a code change.
const site = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || "www.domain-sdk.dev"}`;

// PostHog's public project key. Analytics loads only in production builds that
// set it; requests go through the first-party /ingest proxy in
// integrations/ingest.ts so tracking blockers don't drop them.
const posthogKey = process.env.PUBLIC_POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;

export default defineConfig({
  title: "Domain SDK",
  description:
    "Open-source TypeScript SDK for adding, verifying, and monitoring customer domains across Vercel, Cloudflare, Railway, Render, Netlify, and bunny.net, with DNS writes for Porkbun, Namecheap, and Spaceship.",
  logo: { image: "/logo.svg", text: "Domain SDK" },

  // content/docs serves /docs/*, content/blog serves /blog/*, and pages/
  // holds the landing page, the blog index, and the human-readable sitemap.
  content: {
    root: "content",
  },

  github: {
    owner: "opencoredev",
    repo: "domain-sdk",
    branch: "main",
    dir: "apps/docs",
  },

  theme: {
    // The landing page's warm near-black and paper white, with the docs'
    // periwinkle accent. The full palette lives in theme.css.
    accent: { light: "#3d5fb8", dark: "#8aabff" },
    background: { dark: "#090908" },
    radius: "sm",
    mode: "dark",
    toggle: false,
    fonts: {
      display: "geist",
      body: "geist",
      mono: "geist-mono",
    },
  },

  markdown: {
    code: {
      theme: { light: "github-light", dark: "github-dark-default" },
    },
  },

  navigation: {
    // Collapsible groups, as in the Fumadocs sidebar: Providers starts open
    // (its meta.ts), the rest open when they hold the current page.
    sidebar: { display: "group" },
    tabs: [
      { label: "Docs", path: "/docs" },
      { label: "Blog", path: "/blog" },
    ],
    actions: [
      { label: "Changelog", href: "/docs/project/changelog" },
      { label: "npm", href: "https://www.npmjs.com/package/@opencoredev/domain-sdk" },
      { label: "Sponsor", href: "https://github.com/sponsors/opencoredev" },
      { label: "GitHub", href: "https://github.com/opencoredev/domain-sdk" },
    ],
  },

  footer: {
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "Blog", href: "/blog" },
      { label: "Sitemap", href: "/sitemap" },
      { label: "Contributing", href: "/docs/project/contributing" },
      { label: "Sponsor", href: "https://github.com/sponsors/opencoredev" },
    ],
  },

  search: {
    popular: [
      { href: "/docs/installation", label: "Installation", icon: "rocket" },
      { href: "/docs/providers", label: "Providers", icon: "plug" },
      { href: "/docs/guides/custom-domain-settings-page", label: "Custom domain settings page" },
      { href: "/docs/guides/troubleshoot-dns", label: "Troubleshoot DNS" },
      { href: "/docs/api-reference/create-domain-client", label: "createDomainClient" },
      { href: "/docs/components/dns-records-table", label: "DNS records table" },
    ],
  },

  agents: {
    llmsTxt: {
      details: [
        "Reach for Domain SDK (`@opencoredev/domain-sdk`) when a server-side TypeScript app needs to add, verify, monitor, and remove customer custom domains on Vercel, Cloudflare for SaaS, Railway, Render, Netlify, or bunny.net, or write DNS records at Porkbun, Namecheap, or Spaceship. Install with `bun add @opencoredev/domain-sdk` and import each provider from its own subpath, such as `@opencoredev/domain-sdk/vercel`.",
        "",
        "- Package: `@opencoredev/domain-sdk`, MIT license, server-side Node.js 20+ or Bun.",
        "- Domain SDK manages domain lifecycle calls and normalized DNS instructions. It does not register domains, host DNS, proxy traffic, or store tenant data.",
        "- `createDomainClient({ provider })` returns `add`, `get`, `list`, `verify`, `remove`, and `waitUntilActive`; `createDnsClient()` writes the returned records into a registrar zone.",
        "- `memoryProvider()` from `@opencoredev/domain-sdk/testing` runs without network access, for tests.",
        "- Install the agent skill: `npx skills add opencoredev/domain-sdk --skill domain-sdk`.",
        `- The blog at ${site}/blog has longer guides on custom domains for SaaS apps and registrar DNS APIs. RSS: ${site}/blog/rss.xml`,
        `- The human-readable sitemap at ${site}/sitemap groups every page by topic.`,
        "",
        "Every page below is also available as Markdown: append `.md` to its URL.",
      ].join("\n"),
    },
    // Search and read these docs from an agent:
    // claude mcp add --transport http domain-sdk https://www.domain-sdk.dev/mcp
    mcp: { enabled: true },
  },

  // Sitemap <lastmod> and "Last updated" stamps come from each page's last
  // commit. Vercel clones shallowly by default, so the project needs
  // VERCEL_DEEP_CLONE=true; without it, pages whose history is truncated omit
  // dates rather than stamping the migration commit date.
  lastModified: "git",

  seo: {
    jsonLd: {
      author: { "@id": `${site}#organization` },
    },
    // Shipped via public/robots.txt to preserve Blume's Content-Signal line
    // alongside Disallow rules for /api/ and /ingest/.
    robots: false,
    metatags: {
      // Tells Is Agentic (is-agentic.com) to read this as a documentation site.
      "is-agentic-site-type": "content",
    },
    og: {
      palette: { background: "#090908", foreground: "#f4f3ef", accent: "#8aabff" },
    },
    organization: {
      name: "OpenCoreDev",
      url: "https://github.com/opencoredev",
      logo: "/images/domain-sdk-logo.png",
      sameAs: ["https://github.com/opencoredev", "https://www.npmjs.com/org/opencoredev"],
    },
    software: {
      name: "Domain SDK",
      license: "https://github.com/opencoredev/domain-sdk/blob/main/LICENSE",
      operatingSystem: "Any (server-side Node.js 20+ or Bun)",
      price: 0,
      sameAs: [
        "https://www.npmjs.com/package/@opencoredev/domain-sdk",
        "https://github.com/opencoredev/domain-sdk",
      ],
    },
  },

  analytics: posthogKey
    ? [
        posthog({
          key: posthogKey,
          host: "/ingest",
          ui_host: "https://us.posthog.com",
          defaults: "2026-05-30",
          capture_exceptions: true,
          capture_dead_clicks: true,
        }),
        script({ src: "/js/analytics-listeners.js", strategy: "defer" }),
      ]
    : [],

  // Server output on Vercel, so /mcp runs, the /ingest proxy answers, and
  // every docs page, blog post, and the homepage answer `Accept: text/markdown`
  // at their own URL. The /blog and /sitemap index pages have no Markdown version.
  deployment: vercel({ site }),

  // URLs from before the docs were consolidated and former Fumadocs Markdown
  // endpoints, served as permanent (308) redirects.
  redirects: [...legacyDocRedirects, ...legacyMarkdownRedirects],

  // No feedback endpoint is configured, so a rating would go nowhere.
  feedback: false,

  // og:video on the homepage, FAQPage JSON-LD on pages with an FAQ section,
  // and the /ingest PostHog proxy (integrations/).
  integrations: [domainSite()],
});
