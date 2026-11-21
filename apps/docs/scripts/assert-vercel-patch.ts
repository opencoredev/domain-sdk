import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { ENTRY_PATCH_MARKER } from "./patch-vercel-routes";

const docsDir = resolve(import.meta.dir, "..");
const configPath = resolve(docsDir, ".vercel/output/config.json");
const entryPath = resolve(
  docsDir,
  ".vercel/output/functions/_render.func/apps/docs/dist/server/entry.mjs",
);
const staticDir = resolve(docsDir, ".vercel/output/static");
const sitemapPath = join(staticDir, "sitemap.xml");
const pagesIndexPath = join(staticDir, "api/docs/pages.json");
const chunksDir = resolve(
  docsDir,
  ".vercel/output/functions/_render.func/apps/docs/dist/server/chunks",
);

const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  routes?: Array<{
    src?: string;
    dest?: string;
    status?: number;
    headers?: Record<string, string>;
  }>;
};
const routes = config.routes ?? [];

const slashIndex = routes.findIndex((r) => r.src === "^/(.*)/$" && r.status === 308);
if (slashIndex < 0) {
  throw new Error("Missing Blume trailing-slash 308 route (^/(.*)/$) in Vercel config.json.");
}

for (const expectedSrc of ["^/ingest(?:/.*)?/$", "^/ingest(?:/(.*))?$"]) {
  const index = routes.findIndex((r) => r.src === expectedSrc && r.dest === "_render");
  if (index < 0 || index > slashIndex) {
    throw new Error(
      `Missing or misordered /ingest route (${expectedSrc}) ahead of ^/(.*)/$ in Vercel config.json.`,
    );
  }
}

const llmsNoindex = routes.some(
  (r) => r.src === "^/llms(?:-full)?\\.txt$" && r.headers?.["x-robots-tag"] === "noindex",
);
if (!llmsNoindex) {
  throw new Error(
    "Missing X-Robots-Tag: noindex header route for /llms.txt in Vercel config.json.",
  );
}

const entry = readFileSync(entryPath, "utf8");
if (!entry.includes(ENTRY_PATCH_MARKER)) {
  throw new Error(
    `Missing ingest trailing-slash patch marker (${ENTRY_PATCH_MARKER}) in built server entry.mjs.`,
  );
}

const sitemap = readFileSync(sitemapPath, "utf8");
if (!/<url><loc>/.test(sitemap)) {
  throw new Error("Built sitemap.xml is missing <url><loc> entries.");
}

const sitemapDates = new Map<string, string>();
for (const match of sitemap.matchAll(
  /<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?<\/url>/g,
)) {
  const pathname = new URL(match[1]!).pathname;
  if (match[2]) sitemapDates.set(pathname, match[2]);
}

const pagesIndex = JSON.parse(readFileSync(pagesIndexPath, "utf8")) as {
  pages?: Array<{ route?: string; lastModified?: string }>;
};
for (const page of pagesIndex.pages ?? []) {
  if (!page.route) continue;
  const expected = sitemapDates.get(page.route);
  const actual = page.lastModified?.slice(0, 10);
  if (expected !== actual) {
    throw new Error(
      `pages.json lastModified mismatch for ${page.route}: expected ${expected ?? "omitted"}, got ${actual ?? "omitted"}.`,
    );
  }
  const perPageJsonPath = join(
    staticDir,
    "api/docs/pages",
    `${page.route.replace(/^\/+/, "")}.json`,
  );
  if (existsSync(perPageJsonPath)) {
    const detail = JSON.parse(readFileSync(perPageJsonPath, "utf8")) as { lastModified?: string };
    const detailDate = detail.lastModified?.slice(0, 10);
    if (expected !== detailDate) {
      throw new Error(
        `Per-page JSON lastModified mismatch for ${page.route}: expected ${expected ?? "omitted"}, got ${detailDate ?? "omitted"}.`,
      );
    }
  }
  const htmlCandidates = [
    join(staticDir, page.route.replace(/^\/+/, ""), "index.html"),
    join(staticDir, `${page.route.replace(/^\/+/, "")}.html`),
  ];
  const htmlPath = htmlCandidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (htmlPath) {
    const html = readFileSync(htmlPath, "utf8");
    const htmlDate = html.match(/"dateModified":"(\d{4}-\d{2}-\d{2})/)?.[1];
    if (expected !== htmlDate) {
      throw new Error(
        `HTML dateModified mismatch for ${page.route}: expected ${expected ?? "omitted"}, got ${htmlDate ?? "omitted"}.`,
      );
    }
  }
}

const mcpChunks = readdirSync(chunksDir).filter(
  (file) => file.startsWith("_blume_mcp-data_") && file.endsWith(".mjs"),
);
if (mcpChunks.length === 0) {
  throw new Error("Expected built _blume_mcp-data_*.mjs chunk in server bundle.");
}
for (const file of mcpChunks) {
  const chunk = readFileSync(join(chunksDir, file), "utf8");
  for (const match of chunk.matchAll(
    /\\"lastModified\\":\\"([^"]+)\\",\\"locale\\":\\"[^"]*\\",\\"route\\":\\"([^"]+)\\"/g,
  )) {
    const actual = match[1]!.slice(0, 10);
    const route = match[2]!;
    const expected = sitemapDates.get(route);
    if (expected !== actual) {
      throw new Error(
        `${file} lastModified mismatch for ${route}: expected ${expected ?? "omitted"}, got ${actual}.`,
      );
    }
  }
}

const homeHtml = readFileSync(join(staticDir, "index.html"), "utf8");
if (homeHtml.includes("fonts.googleapis.com")) {
  throw new Error(
    "Home page index.html should self-host Outfit instead of loading fonts.googleapis.com.",
  );
}

const blogHtml = readFileSync(join(staticDir, "blog/index.html"), "utf8");
if (!blogHtml.includes('"@type":"Blog"')) {
  throw new Error('Expected blog/index.html JSON-LD to emit "@type":"Blog".');
}

const sitemapHtml = readFileSync(join(staticDir, "sitemap/index.html"), "utf8");
if (
  !sitemapHtml.includes('"@type":"CollectionPage"') ||
  sitemapHtml.includes('"@type":"TechArticle"')
) {
  throw new Error(
    'Expected sitemap/index.html JSON-LD to emit "@type":"CollectionPage" instead of TechArticle.',
  );
}

const sampleDocHtml = readFileSync(join(staticDir, "docs/providers/vercel/index.html"), "utf8");
if (!sampleDocHtml.includes('"author":{"@id":"https://www.domain-sdk.dev#organization"}')) {
  throw new Error("Expected docs article JSON-LD to include organization author @id.");
}

const sampleBlogPostHtml = readFileSync(
  join(staticDir, "blog/cloudflare-for-saas/index.html"),
  "utf8",
);
if (
  !sampleBlogPostHtml.includes('class="domain-blog-byline"') ||
  !sampleBlogPostHtml.includes("Domain SDK team")
) {
  throw new Error("Expected blog post HTML to render publish date and Domain SDK team byline.");
}

console.log(
  `Verified Vercel post-build patch: /ingest routes, /llms.txt noindex, ${ENTRY_PATCH_MARKER}, /blog & /sitemap JSON-LD, self-hosted Outfit, and synced sitemap/agent JSON/MCP dates.`,
);
