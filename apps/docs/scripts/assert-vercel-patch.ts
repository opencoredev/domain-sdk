import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ENTRY_PATCH_MARKER } from "./patch-vercel-routes";

const docsDir = resolve(import.meta.dir, "..");
const configPath = resolve(docsDir, ".vercel/output/config.json");
const entryPath = resolve(
  docsDir,
  ".vercel/output/functions/_render.func/apps/docs/dist/server/entry.mjs",
);
const sitemapPath = resolve(docsDir, ".vercel/output/static/sitemap.xml");

const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  routes?: Array<{ src?: string; dest?: string; status?: number }>;
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

console.log(
  `Verified Vercel post-build patch: both /ingest routes precede ^/(.*)/$, server entry contains ${ENTRY_PATCH_MARKER}, and sitemap.xml is populated.`,
);
