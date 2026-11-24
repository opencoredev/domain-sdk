// What the site needs beyond Blume's config:
// - middleware.ts edits the finished HTML, because PageLayout has no head slot
//   and `seo.metatags` would reach every page. It adds og:video to the
//   homepage (iMessage, Discord, and Telegram play the animated preview) and
//   FAQPage JSON-LD to every docs page and blog post with an FAQ section.
// - ingest.ts is the first-party PostHog proxy at /ingest/*. Blume mounts only
//   `.astro` files from pages/, so the endpoint is injected here.

import type { AstroIntegration } from "astro";

export const domainSite = (): AstroIntegration => ({
  name: "domain-sdk-site",
  hooks: {
    "astro:config:setup": ({ addMiddleware, injectRoute }) => {
      // Outermost, so it sees the page after Blume's own middleware finished it.
      addMiddleware({
        entrypoint: new URL("./middleware.ts", import.meta.url),
        order: "pre",
      });
      injectRoute({
        pattern: "/ingest/[...path]",
        entrypoint: new URL("./ingest.ts", import.meta.url),
        prerender: false,
      });
    },
  },
});
