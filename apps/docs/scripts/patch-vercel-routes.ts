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
  { src: "^/ingest(?:/.*)?/$", dest: "_render" },
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
 * Deduplicates `/ingest` routes and places terminal `/ingest` routes ahead of
 * Blume's generic `^/(.*)/$` 308 redirect so PostHog endpoints like `/ingest/e/`
 * and `/ingest/flags/?v=2` reach the Vercel function directly with their full
 * query string intact.
 */
export function patchVercelRoutes(config: VercelOutputConfig): VercelOutputConfig {
  if (!Array.isArray(config.routes)) {
    throw new Error("Expected Vercel output config.json to contain a routes array.");
  }

  const deduped = config.routes.filter((route) => {
    const src = route.src ?? "";
    return !src.startsWith("^/ingest");
  });

  const trailingSlashIndex = deduped.findIndex(
    (route) => route.src === "^/(.*)/$" && route.status === 308,
  );
  if (trailingSlashIndex === -1) {
    throw new Error(
      "Expected Blume trailing-slash 308 route (^/(.*)/$) in Vercel config.json; update patch-vercel-routes.ts.",
    );
  }

  const nextRoutes = [...deduped];
  nextRoutes.splice(trailingSlashIndex, 0, ...INGEST_ROUTES);
  return { ...config, routes: nextRoutes };
}

export const ENTRY_PATCH_MARKER = "/* __domain_sdk_ingest_ts_patch__ */";

/**
 * Patches Astro's built Vercel server entry so direct requests to `/ingest/<path>/`
 * (including `POST /ingest/e/`, `POST /ingest/batch/`, and `GET /ingest/flags/?v=2`)
 * bypass Astro's `trailingSlash: "never"` 308/301 normalization inside `_render`
 * while preserving existing query params and the trailing slash via `__ts=1`.
 */
export function patchServerEntry(source: string): string {
  if (source.includes(ENTRY_PATCH_MARKER)) return source;
  const anchor = "const routeData = app.match(request);";
  if (!source.includes(anchor)) {
    throw new Error(
      `Expected Astro server entry anchor (${anchor}) in entry.mjs; update patch-vercel-routes.ts.`,
    );
  }

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
  if (!/<url><loc>/.test(xml)) {
    throw new Error(
      "Expected <url><loc> entries in sitemap.xml; update patch-vercel-routes.ts if Blume changed its sitemap format.",
    );
  }
  return xml.replace(
    /<url><loc>([^<]+)<\/loc>(?:<lastmod>[^<]*<\/lastmod>)?<\/url>/g,
    (match, loc: string) => {
      try {
        const pathname = new URL(loc).pathname;
        const date = resolveDate(pathname);
        if (!date) return `<url><loc>${loc}</loc></url>`;
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

function findMigrationBoundary(repoRoot: string): string | undefined {
  // The commit that removed apps/fumadocs (or added apps/docs/blume.config.ts).
  return (
    gitOutput(
      ["log", "-1", "--diff-filter=D", "--format=%H", "--", "apps/fumadocs/package.json"],
      repoRoot,
    ) ??
    gitOutput(
      ["log", "--diff-filter=A", "--format=%H", "--", "apps/docs/blume.config.ts"],
      repoRoot,
    )
      ?.split("\n")
      .at(-1)
  );
}

function isLastModifiedOnlyDiff(repoRoot: string, commit: string, relPath: string): boolean {
  const diff = gitOutput(["show", "--unified=0", "--format=", commit, "--", relPath], repoRoot);
  if (!diff) return false;
  const changed = diff
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") &&
        !line.startsWith("---"),
    );
  return changed.length > 0 && changed.every((line) => /^[+-]lastModified:/.test(line));
}

export function createGitDateResolver(docsDir: string): (pathname: string) => string | undefined {
  const repoRoot =
    gitOutput(["rev-parse", "--show-toplevel"], docsDir) ?? resolve(docsDir, "../..");
  const isShallow = gitOutput(["rev-parse", "--is-shallow-repository"], repoRoot) === "true";
  const shallowRoots = new Set(
    isShallow
      ? (gitOutput(["rev-list", "--max-parents=0", "HEAD"], repoRoot)?.split("\n") ?? [])
      : [],
  );
  const migrationBoundary = findMigrationBoundary(repoRoot);
  const contentDir = join(docsDir, "content");

  const gitDate = (relPath: string, diffFilter?: string): string | undefined => {
    const out = gitOutput(
      [
        "log",
        "-1",
        ...(diffFilter ? [`--diff-filter=${diffFilter}`] : []),
        "--format=%H %cs",
        "--",
        relPath,
      ],
      repoRoot,
    );
    if (!out) return undefined;
    const [hash, date] = out.split(" ");
    if (!hash || !date || shallowRoots.has(hash)) return undefined;
    return date;
  };

  const postMigrationDate = (relPath: string): string | undefined => {
    if (!migrationBoundary) return undefined;
    const commits = gitOutput(
      ["log", "-n", "10", "--diff-filter=AM", "--format=%H", "--", relPath],
      repoRoot,
    )?.split("\n");
    if (!commits) return undefined;
    for (const commit of commits) {
      if (commit === migrationBoundary || shallowRoots.has(commit)) return undefined;
      if (isLastModifiedOnlyDiff(repoRoot, commit, relPath)) continue;
      return gitOutput(["show", "-s", "--format=%cs", commit], repoRoot);
    }
    return undefined;
  };

  const resolveContentDate = (relContentPath: string): string | undefined => {
    const currentPath = `apps/docs/content/${relContentPath}`;
    const legacyPath = `apps/fumadocs/content/${relContentPath}`;
    if (MIGRATION_EDITED_CONTENT.has(relContentPath)) {
      return gitDate(currentPath, "AM");
    }
    return (
      postMigrationDate(currentPath) ??
      gitDate(legacyPath, "AM") ??
      (!isShallow && !migrationBoundary ? gitDate(currentPath, "AM") : undefined)
    );
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
      return (
        postMigrationDate(current) ??
        gitDate("apps/fumadocs/src/app/(home)/page.tsx", "AM") ??
        (!isShallow && !migrationBoundary ? gitDate(current, "AM") : undefined)
      );
    }
    if (clean === "/blog") {
      const current = "apps/docs/content/blog";
      return (
        postMigrationDate(current) ??
        gitDate("apps/fumadocs/content/blog", "AM") ??
        (!isShallow && !migrationBoundary ? gitDate(current, "AM") : undefined)
      );
    }
    if (clean === "/sitemap") {
      const current = "apps/docs/content";
      return (
        postMigrationDate(current) ??
        gitDate("apps/fumadocs/content", "AM") ??
        (!isShallow && !migrationBoundary ? gitDate(current, "AM") : undefined)
      );
    }
    const rel = contentRelForRoute(clean);
    if (!rel) return undefined;
    return resolveContentDate(rel);
  };
}

export function rewriteHtmlModifiedDates(html: string, date: string | undefined): string {
  if (!date) {
    return html
      .replace(/,"dateModified":"\d{4}-\d{2}-\d{2}T[^"]*"/g, "")
      .replace(/"dateModified":"\d{4}-\d{2}-\d{2}T[^"]*",/g, "")
      .replace(/<meta\b[^>]*\bproperty="article:modified_time"[^>]*>/g, "")
      .replace(/<p\b[^>]*>Last updated on <time\b[^>]*>[^<]*<\/time><\/p>/g, "");
  }
  const iso = `${date}T00:00:00.000Z`;
  const label = new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return html
    .replace(/"dateModified":"\d{4}-\d{2}-\d{2}T[^"]*"/g, `"dateModified":"${iso}"`)
    .replace(
      /(<meta\b[^>]*\bproperty="article:modified_time"[^>]*\bcontent=")[^"]*(")/g,
      `$1${iso}$2`,
    )
    .replace(
      /(<meta\b[^>]*\bcontent=")[^"]*("[^>]*\bproperty="article:modified_time")/g,
      `$1${iso}$2`,
    )
    .replace(/(Last updated on <time datetime=")[^"]*(">)[^<]*(<\/time>)/g, `$1${iso}$2${label}$3`);
}

function patchStaticDateModified(
  staticDir: string,
  pathname: string,
  date: string | undefined,
): void {
  const clean = pathname === "/" ? "" : pathname.replace(/^\/+|\/+$/g, "");
  const candidates =
    clean === ""
      ? [join(staticDir, "index.html")]
      : [join(staticDir, `${clean}.html`), join(staticDir, clean, "index.html")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const html = readFileSync(file, "utf8");
    const next = rewriteHtmlModifiedDates(html, date);
    if (next !== html) writeFileSync(file, next, "utf8");
  }
}

if (import.meta.main) {
  const docsDir = process.cwd();
  const repoRoot =
    gitOutput(["rev-parse", "--show-toplevel"], docsDir) ?? resolve(docsDir, "../..");
  if (gitOutput(["rev-parse", "--is-shallow-repository"], repoRoot) === "true") {
    console.warn(
      "[patch-vercel-routes] Shallow git clone detected; set VERCEL_DEEP_CLONE=true so sitemap dates preserve pre-migration history.",
    );
  }

  const configPath = resolve(docsDir, ".vercel/output/config.json");
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as VercelOutputConfig;
  const patched = patchVercelRoutes(parsed);
  writeFileSync(configPath, `${JSON.stringify(patched, null, "\t")}\n`, "utf8");

  const entryPath = resolve(
    docsDir,
    ".vercel/output/functions/_render.func/apps/docs/dist/server/entry.mjs",
  );
  if (!existsSync(entryPath)) {
    throw new Error(`Expected Vercel server entry at ${entryPath}; update patch-vercel-routes.ts.`);
  }
  const entrySource = readFileSync(entryPath, "utf8");
  const nextEntry = patchServerEntry(entrySource);
  if (nextEntry !== entrySource) writeFileSync(entryPath, nextEntry, "utf8");

  const staticDir = resolve(docsDir, ".vercel/output/static");
  const sitemapPath = join(staticDir, "sitemap.xml");
  if (!existsSync(sitemapPath)) {
    throw new Error(`Expected sitemap.xml at ${sitemapPath}; update patch-vercel-routes.ts.`);
  }
  const resolveDate = createGitDateResolver(docsDir);
  const xml = readFileSync(sitemapPath, "utf8");
  const nextXml = patchSitemapXml(xml, (pathname) => {
    const date = resolveDate(pathname);
    patchStaticDateModified(staticDir, pathname, date);
    return date;
  });
  if (nextXml !== xml) writeFileSync(sitemapPath, nextXml, "utf8");
}
