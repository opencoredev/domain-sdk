export const siteConfig = {
  name: "Domain SDK",
  url: "https://domain-sdk.dev",
  title: "Custom Domains SDK for TypeScript | Domain SDK",
  description:
    "Open-source TypeScript SDK for adding, verifying, and monitoring customer domains across Vercel, Cloudflare, Railway, Render, and Netlify.",
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

export function absoluteUrl(path: string) {
  return new URL(path, siteConfig.url).toString();
}

export function pageNameFromSlug(slug: string) {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
