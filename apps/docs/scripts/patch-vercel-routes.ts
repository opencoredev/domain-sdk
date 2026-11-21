import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface VercelRoute {
  src?: string;
  dest?: string;
  status?: number;
  headers?: Record<string, string>;
  continue?: boolean;
  handle?: string;
}

export interface VercelOutputConfig {
  version: number;
  routes?: VercelRoute[];
  [key: string]: unknown;
}

const INGEST_ROUTES: VercelRoute[] = [
  { src: "^/ingest/$", dest: "/ingest?__ts=1", continue: true },
  { src: "^/ingest/(.+)/$", dest: "/ingest/$1?__ts=1", continue: true },
  { src: "^/ingest(?:/(.*))?$", dest: "_render" },
];

// Pages whose body content was substantively updated during the Blume migration,
// so their sitemap dates should reflect the migration commit rather than the
// legacy Fumadocs commit.
const MIGRATION_EDITED_CONTENT = new Set([
  "docs/project/contributing.mdx",
  "docs/installation.mdx",
  "docs/components/index.mdx",
]);

/**
 * Deduplicates `/ingest` routes and places trailing-slash rewrites plus the
 * `/ingest/*` proxy route ahead of Blume's generic `^/(.*)/$` 308 redirect so
 * PostHog endpoints like `/ingest/e/` and `/ingest/batch/` reach the function
 * directly without a redirect hop.
 */
export function patchVercelRoutes(config: VercelOutputConfig): VercelOutputConfig {
  if (!Array.isArray(config.routes)) return config;

  const deduped = config.routes.filter((route) => {
    const src = route.src ?? "";
    return !src.startsWith("^/ingest");
  });

  const trailingSlashIndex = deduped.findIndex(
    (route) => route.src === "^/(.*)/$" && route.status === 308,
  );
  if (trailingSlashIndex === -1) return { ...config, routes: deduped };

  const nextRoutes = [...deduped];
  nextRoutes.splice(trailingSlashIndex, 0, ...INGEST_ROUTES);
  return { ...config, routes: nextRoutes };
}

const ENTRY_PATCH_MARKER = "/* __domain_sdk_ingest_ts_patch__ */";

/**
 * Patches Astro's built Vercel server entry so direct requests to `/ingest/<path>/`
 * (including `POST /ingest/e/`, `POST /ingest/batch/`, and `GET /ingest/flags/`)
 * bypass Astro's `trailingSlash: "never"` 308/301 normalization inside `_render`
 * while preserving the trailing slash via `__ts=1` for `integrations/ingest.ts`.
 */
export function patchServerEntry(source: string): string {
  if (source.includes(ENTRY_PATCH_MARKER)) return source;
  const anchor = "const routeData = app.match(request);";
  if (!source.includes(anchor)) return source;

  const snippet = `${ENTRY_PATCH_MARKER}
	const __ingestUrl = new URL(request.url);
	if (__ingestUrl.pathname === "/ingest/" || /^\\/ingest\\/.+\\/$/.test(__ingestUrl.pathname)) {
		__ingestUrl.pathname = __ingestUrl.pathname.slice(0, -1);
		__ingestUrl.searchParams.set("__ts", "1");
		request = new Request(__ingestUrl.toString(), {
			method: request.method,
			headers: request.headers,
			...request.body ? { body: request.body, duplex: "half" } : {}
		});
	}
	${anchor}`;

  return source.replace(anchor, snippet);
}

/**
 * Updates `<lastmod>` elements in `sitemap.xml` using `resolveDate(pathname)`.
 * Adds `<lastmod>` to custom pages (`/`, `/blog`, `/sitemap`) and preserves
 * historical pre-migration dates for unedited content while automatically
 * reflecting any newer git commits.
 */
export function patchSitemapXml(
  xml: string,
  resolveDate: (pathname: string) => string | undefined,
): string {
  return xml.replace(
    /<url><loc>([^<]+)<\/loc>(?:<lastmod>[^<]*<\/lastmod>)?<\/url>/g,
    (match, loc: string) => {
      try {
        const pathname = new URL(loc).pathname;
        const date = resolveDate(pathname);
        if (!date) return match;
        return `<url><loc>${loc}</loc><lastmod>${date}</lastmod></url>`;
      } catch {
        return match;
      }
    },
  );
}

function gitOutput(args: string[], cwd: string): string | undefined {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function findMigrationCutoff(repoRoot: string): string | undefined {
  // Latest commit that still contained apps/fumadocs (last pre-migration or migration commit).
  const firstBlume = gitOutput(
    ["log", "--diff-filter=A", "--format=%H", "--", "apps/docs/blume.config.ts"],
    repoRoot,
  )
    ?.split("\n")
    .at(-1);
  return firstBlume;
}

function createGitDateResolver(docsDir: string): (pathname: string) => string | undefined {
  const repoRoot =
    gitOutput(["rev-parse", "--show-toplevel"], docsDir) ?? resolve(docsDir, "../..");
  const firstBlumeCommit = findMigrationCutoff(repoRoot);
  const contentDir = join(docsDir, "content");

  const gitDate = (relPath: string, diffFilter?: string): string | undefined =>
    gitOutput(
      [
        "log",
        "-1",
        ...(diffFilter ? [`--diff-filter=${diffFilter}`] : []),
        "--format=%cs",
        "--",
        relPath,
      ],
      repoRoot,
    );

  const hasPostMigrationCommit = (relPath: string): boolean => {
    if (!firstBlumeCommit) return false;
    // Check if the file was modified in a commit strictly after the migration commit(s)
    // that still touched apps/docs/blume.config.ts or apps/fumadocs.
    const latestCommit = gitOutput(["log", "-1", "--format=%H", "--", relPath], repoRoot);
    if (!latestCommit || latestCommit === firstBlumeCommit) return false;
    const filesInLatest = gitOutput(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", latestCommit],
      repoRoot,
    );
    if (!filesInLatest) return false;
    const isMigrationCommit =
      filesInLatest.includes("apps/docs/blume.config.ts") ||
      filesInLatest.includes("apps/fumadocs/") ||
      filesInLatest.includes("apps/docs/scripts/patch-vercel-routes.ts");
    return !isMigrationCommit;
  };

  const resolveContentDate = (relContentPath: string): string | undefined => {
    const currentPath = `apps/docs/content/${relContentPath}`;
    const legacyPath = `apps/fumadocs/content/${relContentPath}`;
    const currentDate = gitDate(currentPath, "AM");
    if (MIGRATION_EDITED_CONTENT.has(relContentPath) || hasPostMigrationCommit(currentPath)) {
      return currentDate;
    }
    return gitDate(legacyPath, "AM") ?? currentDate;
  };

  const contentRelForRoute = (pathname: string): string | undefined => {
    const clean = pathname.replace(/\/+$/, "");
    if (!/^\/(docs|blog)(\/[\w-]+)*$/.test(clean)) return undefined;
    const rel = clean.slice(1);
    if (existsSync(join(contentDir, `${rel}.mdx`))) return `${rel}.mdx`;
    if (existsSync(join(contentDir, rel, "index.mdx"))) return `${rel}/index.mdx`;
    return undefined;
  };

  return (pathname: string): string | undefined => {
    const clean = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
    if (clean === "/") {
      const current = "apps/docs/pages/index.astro";
      return hasPostMigrationCommit(current)
        ? gitDate(current, "AM")
        : (gitDate("apps/fumadocs/src/app/(home)/page.tsx", "AM") ?? gitDate(current, "AM"));
    }
    if (clean === "/blog") {
      const current = "apps/docs/content/blog";
      return hasPostMigrationCommit(current)
        ? gitDate(current, "AM")
        : (gitDate("apps/fumadocs/content/blog", "AM") ?? gitDate(current, "AM"));
    }
    if (clean === "/sitemap") {
      const current = "apps/docs/content";
      return hasPostMigrationCommit(current)
        ? gitDate(current, "AM")
        : (gitDate("apps/fumadocs/content", "AM") ?? gitDate(current, "AM"));
    }
    const rel = contentRelForRoute(clean);
    if (!rel) return undefined;
    return resolveContentDate(rel);
  };
}

function patchStaticDateModified(staticDir: string, pathname: string, date: string): void {
  const clean = pathname === "/" ? "" : pathname.replace(/^\/+|\/+$/g, "");
  const candidates =
    clean === ""
      ? [join(staticDir, "index.html")]
      : [join(staticDir, `${clean}.html`), join(staticDir, clean, "index.html")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const html = readFileSync(file, "utf8");
    const next = html.replace(
      /"dateModified":"\d{4}-\d{2}-\d{2}T[^"]*"/g,
      `"dateModified":"${date}T00:00:00.000Z"`,
    );
    if (next !== html) writeFileSync(file, next, "utf8");
  }
}

if (import.meta.main) {
  const docsDir = process.cwd();
  const configPath = resolve(docsDir, ".vercel/output/config.json");
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as VercelOutputConfig;
  const patched = patchVercelRoutes(parsed);
  writeFileSync(configPath, `${JSON.stringify(patched, null, "\t")}\n`, "utf8");

  const entryPath = resolve(
    docsDir,
    ".vercel/output/functions/_render.func/apps/docs/dist/server/entry.mjs",
  );
  if (existsSync(entryPath)) {
    const entrySource = readFileSync(entryPath, "utf8");
    const nextEntry = patchServerEntry(entrySource);
    if (nextEntry !== entrySource) writeFileSync(entryPath, nextEntry, "utf8");
  }

  const staticDir = resolve(docsDir, ".vercel/output/static");
  const sitemapPath = join(staticDir, "sitemap.xml");
  if (existsSync(sitemapPath)) {
    const resolveDate = createGitDateResolver(docsDir);
    const xml = readFileSync(sitemapPath, "utf8");
    const nextXml = patchSitemapXml(xml, (pathname) => {
      const date = resolveDate(pathname);
      if (date) patchStaticDateModified(staticDir, pathname, date);
      return date;
    });
    if (nextXml !== xml) writeFileSync(sitemapPath, nextXml, "utf8");
  }
}
