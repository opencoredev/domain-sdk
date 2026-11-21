# Domain SDK docs

The Domain SDK website, docs, and blog, built with [Blume](https://useblume.dev). The SDK itself lives in `packages/sdk`.

```bash
bun install                 # from the repository root
bun run dev                 # in apps/docs: blume dev on http://localhost:4321
bun run build               # Vercel server output in .vercel/output
bun run validate            # blume validate --strict: links, navigation, frontmatter
bun run audit               # blume audit: SEO and site health of the last build
bun run check:snippets      # type-checks every docs code block against the SDK source
bun run test                # FAQ JSON-LD, middleware, and /ingest proxy tests
```

## Layout

- `content/docs/` serves `/docs/*`. Each folder is a sidebar group configured by its `meta.ts`.
- `content/blog/` serves `/blog/*`. Posts are `type: blog` pages; Blume builds `/blog/rss.xml` from them.
- `pages/index.astro` is the landing page, with its styles and scripts in `pages/_home/`. `pages/blog/index.astro` lists posts, and `pages/sitemap.astro` is the human-readable `/sitemap`.
- `islands/` holds the live component previews used on the component pages (`<DnsRecordsPreview />`, `<OneClickDnsPreview />`), built from the shadcn primitives in `components/ui/`.
- `public/r/` is the shadcn registry output served at `/r/*.json`. Regenerate it from the repository root with `bun run registry:build`; don't edit it by hand.
- `theme.css` sets the palette, page-title serif, sidebar provider marks, and the preview scope. `blume.config.ts` sets navigation, search, `llms.txt`, the MCP server, SEO, analytics, and redirects.
- `integrations/` adds what Blume has no config for: `og:video` on the homepage, FAQPage JSON-LD on pages with an FAQ section, and the `/ingest/*` PostHog proxy.
- `scripts/check-snippets.ts` type-checks ` ```ts ` blocks that have imports. App modules snippets import (`./domains`, `@/server/auth`) are stubbed in `scripts/snippet-stubs/`. Mark a block that shouldn't be checked with `ignore="reason"` in its fence.

## Deployment

The site deploys to Vercel as a server build (`vercel()` in `blume.config.ts`), so `/mcp`, `/ingest`, and `Accept: text/markdown` negotiation work. The Vercel project needs:

- Root directory `apps/docs`, with the framework preset set to Astro or Other (Blume writes `.vercel/output`).
- `VERCEL_DEEP_CLONE=true`, so each page's "Last updated" date and sitemap `<lastmod>` come from git history.
- `PUBLIC_POSTHOG_KEY` (or the old `NEXT_PUBLIC_POSTHOG_KEY`) for analytics. Without it, no analytics script ships.
