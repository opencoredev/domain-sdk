export const siteConfig = {
  name: "Domain SDK",
  url: "https://www.domain-sdk.dev",
  title: "Custom Domains SDK for TypeScript | Domain SDK",
  description:
    "Open-source TypeScript SDK for adding, verifying, and monitoring customer domains across Vercel, Cloudflare, Railway, Render, Netlify, and bunny.net, with DNS writes for Porkbun, Namecheap, and Spaceship.",
  githubUrl: "https://github.com/opencoredev/domain-sdk",
  npmUrl: "https://www.npmjs.com/package/@opencoredev/domain-sdk",
} as const;

export const legacyDocRoutes = new Set([
  "/docs/how-it-works",
  "/docs/project/provider-adapter-guide",
  "/docs/project/sponsorships",
  "/docs/providers/compatibility",
  "/docs/quickstart",
]);

// Docs MDX directory, relative to the app root (the build's working directory). The sitemap and
// docs JSON-LD both read each page's last git commit from here, so their dates agree.
export const docsContentDir = "content/docs";

export function absoluteUrl(path: string) {
  return new URL(path, siteConfig.url).toString();
}

const acronyms: Record<string, string> = {
  api: "API",
  dns: "DNS",
  mdx: "MDX",
  sdk: "SDK",
  url: "URL",
};

export function pageNameFromSlug(slug: string) {
  return slug
    .split("-")
    .map((word) => acronyms[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
