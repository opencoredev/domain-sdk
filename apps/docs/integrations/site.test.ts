import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALL, upstreamUrl } from "./ingest";
import {
  applyBreadcrumbsToHtml,
  breadcrumbItemsFor,
  contentFileFor,
  docsBreadcrumbJsonLd,
  faqJsonLd,
  homeFontTags,
  ogVideoTags,
} from "./middleware";
import {
  createGitDateResolver,
  patchServerEntry,
  patchSitemapXml,
  patchVercelRoutes,
} from "../scripts/patch-vercel-routes";

const contentRoot = join(import.meta.dir, "..", "content");

describe("contentFileFor", () => {
  test("maps docs, nested docs, folder indexes, and blog posts to their files", () => {
    expect(contentFileFor({ pathname: "/docs", contentRoot })).toBe(
      join(contentRoot, "docs", "index.mdx"),
    );
    expect(contentFileFor({ pathname: "/docs/providers/vercel", contentRoot })).toBe(
      join(contentRoot, "docs", "providers", "vercel.mdx"),
    );
    expect(contentFileFor({ pathname: "/docs/providers/", contentRoot })).toBe(
      join(contentRoot, "docs", "providers", "index.mdx"),
    );
    expect(contentFileFor({ pathname: "/blog/railway-api", contentRoot })).toBe(
      join(contentRoot, "blog", "railway-api.mdx"),
    );
  });

  test("ignores other routes and paths that try to leave the content folder", () => {
    expect(contentFileFor({ pathname: "/", contentRoot })).toBeUndefined();
    expect(contentFileFor({ pathname: "/sitemap", contentRoot })).toBeUndefined();
    expect(contentFileFor({ pathname: "/docs/../package", contentRoot })).toBeUndefined();
    expect(contentFileFor({ pathname: "/docs/missing-page", contentRoot })).toBeUndefined();
  });
});

describe("faqJsonLd", () => {
  test("emits FAQPage JSON-LD for a page with an FAQ section", () => {
    const markdown = `---\ntitle: Test\n---\n\n## FAQ\n\n### Is it free?\n\nYes, it is <b>MIT</b>.\n`;
    const html = faqJsonLd({ markdown, url: "https://www.domain-sdk.dev/docs/test" });
    expect(html.startsWith('<script type="application/ld+json">')).toBe(true);
    const json: unknown = JSON.parse(
      html.replace('<script type="application/ld+json">', "").replace("</script>", ""),
    );
    expect(json).toMatchObject({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [{ name: "Is it free?", acceptedAnswer: { text: "Yes, it is MIT." } }],
    });
    // A literal < never reaches the page, so the script can't be closed early.
    expect(
      faqJsonLd({ markdown: "## FAQ\n\n### a</script>?\n\nb\n", url: "https://x.dev" }),
    ).not.toContain("a</script>");
  });

  test("emits nothing for a page without one", () => {
    expect(faqJsonLd({ markdown: "## Setup\n\nText.\n", url: "https://x.dev" })).toBe("");
  });
});

test("ogVideoTags points every tag at the absolute video URL", () => {
  const tags = ogVideoTags("https://www.domain-sdk.dev/og/og-video.mp4");
  expect(tags).toContain(
    'content="https://www.domain-sdk.dev/og/og-video.mp4" property="og:video"',
  );
  expect(tags).toContain('content="video/mp4" property="og:video:type"');
});

describe("upstreamUrl", () => {
  test("sends static assets to the asset host and the rest to the API host", () => {
    expect(upstreamUrl(new URL("https://www.domain-sdk.dev/ingest/static/array.js")).href).toBe(
      "https://us-assets.i.posthog.com/static/array.js",
    );
    expect(upstreamUrl(new URL("https://www.domain-sdk.dev/ingest/e/?ip=1&ver=1")).href).toBe(
      "https://us.i.posthog.com/e/?ip=1&ver=1",
    );
    expect(upstreamUrl(new URL("https://www.domain-sdk.dev/ingest")).href).toBe(
      "https://us.i.posthog.com/",
    );
  });

  test("restores the trailing slash and strips the internal __ts flag", () => {
    expect(upstreamUrl(new URL("https://www.domain-sdk.dev/ingest/e?__ts=1&ip=1&ver=1")).href).toBe(
      "https://us.i.posthog.com/e/?ip=1&ver=1",
    );
    expect(upstreamUrl(new URL("https://www.domain-sdk.dev/ingest/batch?__ts=1")).href).toBe(
      "https://us.i.posthog.com/batch/",
    );
    expect(upstreamUrl(new URL("https://www.domain-sdk.dev/ingest?__ts=1")).href).toBe(
      "https://us.i.posthog.com/",
    );
  });

  test("preserves the PostHog origin for double-slash paths", () => {
    const target = upstreamUrl(new URL("https://www.domain-sdk.dev/ingest//example.com/probe?x=1"));
    expect(target.origin).toBe("https://us.i.posthog.com");
    expect(target.pathname).toBe("//example.com/probe");
    expect(target.search).toBe("?x=1");
  });
});

describe("ingest proxy handler", () => {
  test("forwards only allowlisted request headers and strips upstream set-cookie headers", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl: URL | undefined;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = input instanceof URL ? input : new URL(String(input));
      capturedHeaders = new Headers(init?.headers);
      return new Response('{"status":"ok"}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "ph_session=abc; Path=/",
          "content-encoding": "gzip",
        },
      });
    }) as typeof fetch;

    try {
      const url = new URL("https://www.domain-sdk.dev/ingest/e?__ts=1&v=2");
      const request = new Request(url, {
        method: "POST",
        headers: {
          cookie: "session=secret",
          authorization: "Bearer secret",
          "content-type": "application/json",
          "user-agent": "domain-sdk-test",
          "x-vercel-forwarded-for": "203.0.113.42",
          "x-vercel-id": "iad1::abc",
          "x-astro-path": "/ingest/e",
          "x-custom": "drop-me",
        },
        body: '{"event":"pageview"}',
      });
      const response = await ALL({ request, url } as Parameters<typeof ALL>[0]);
      expect(capturedUrl?.href).toBe("https://us.i.posthog.com/e/?v=2");
      expect(capturedHeaders?.get("cookie")).toBeNull();
      expect(capturedHeaders?.get("authorization")).toBeNull();
      expect(capturedHeaders?.get("host")).toBeNull();
      expect(capturedHeaders?.get("x-vercel-id")).toBeNull();
      expect(capturedHeaders?.get("x-vercel-forwarded-for")).toBeNull();
      expect(capturedHeaders?.get("x-astro-path")).toBeNull();
      expect(capturedHeaders?.get("x-custom")).toBeNull();
      expect(capturedHeaders?.get("x-forwarded-for")).toBe("203.0.113.42");
      expect(capturedHeaders?.get("content-type")).toBe("application/json");
      expect(capturedHeaders?.get("user-agent")).toBe("domain-sdk-test");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.text()).toBe('{"status":"ok"}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("head injection helpers and Vercel route patching", () => {
  test("homeFontTags emits preconnect and Outfit stylesheet links for head", () => {
    const tags = homeFontTags();
    expect(tags).toContain('rel="preconnect" href="https://fonts.googleapis.com"');
    expect(tags).toContain("family=Outfit:wght@400..700");
  });

  test("docsBreadcrumbJsonLd emits full chains for docs (depths 1-3) and blog posts", () => {
    const site = new URL("https://www.domain-sdk.dev");
    const rootTag = docsBreadcrumbJsonLd({
      pathname: "/docs",
      markdown: "---\ntitle: Intro\n---\n",
      site,
    });
    expect(rootTag).toContain('"@type":"BreadcrumbList"');
    const depth2Tag = docsBreadcrumbJsonLd({
      pathname: "/docs/installation",
      markdown: "---\ntitle: Installation\n---\n",
      site,
    });
    expect(depth2Tag).toContain('"name":"Installation"');
    const depth3Items = breadcrumbItemsFor({
      pathname: "/docs/providers/vercel",
      markdown: "---\ntitle: Vercel\n---\n",
      site,
    });
    expect(depth3Items.map((item) => item.name)).toEqual(["Home", "Docs", "Providers", "Vercel"]);
    const blogItems = breadcrumbItemsFor({
      pathname: "/blog/apex-domain",
      markdown: "---\ntitle: Apex domains\n---\n",
      site,
    });
    expect(blogItems.map((item) => item.name)).toEqual(["Home", "Blog", "Apex domains"]);

    // Replaces Blume's truncated 2-item BreadcrumbList inside @graph instead of duplicating it.
    const blumeHtml =
      '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Providers","item":"https://www.domain-sdk.dev/docs/providers"}]}]}</script></head></html>';
    const patchedHtml = applyBreadcrumbsToHtml({
      html: blumeHtml,
      items: depth3Items,
      extraTags: "",
    });
    expect(patchedHtml.match(/BreadcrumbList/g)).toHaveLength(1);
    expect(patchedHtml).toContain('"name":"Home"');
    expect(patchedHtml).toContain('"name":"Docs"');
    expect(patchedHtml).toContain('"name":"Vercel"');
  });

  test("patchVercelRoutes deduplicates /ingest and places terminal _render routes ahead of the 308 rule", () => {
    const patched = patchVercelRoutes({
      version: 3,
      routes: [
        { src: "^(?:/.*)?$", headers: { "x-powered-by": "Blume" }, continue: true },
        { src: "^/(.*)/$", headers: { Location: "/$1" }, status: 308 },
        { src: "^/ingest(?:/(.*?))?$", dest: "_render" },
      ],
    });
    const routes = patched.routes ?? [];
    const slashIdx = routes.findIndex((route) => route.src === "^/(.*)/$");
    const ingestRoutes = routes.filter((route) => route.src?.startsWith("^/ingest"));
    expect(ingestRoutes).toHaveLength(2);
    expect(routes.findIndex((route) => route.src === "^/ingest(?:/.*)?/$")).toBeLessThan(slashIdx);
    expect(routes.findIndex((route) => route.dest === "_render")).toBeLessThan(slashIdx);
    expect(() => patchVercelRoutes({ version: 3, routes: [] })).toThrow(/trailing-slash 308/);
  });

  test("patchServerEntry rewrites /ingest/*/ before app.match, is idempotent, and throws when anchor is missing", () => {
    const sample = "const routeData = app.match(request);";
    const once = patchServerEntry(sample);
    expect(once).toContain('__ingestUrl.searchParams.set("__ts", "1")');
    expect(patchServerEntry(once)).toBe(once);
    expect(() => patchServerEntry("export default {};")).toThrow(/anchor/);
  });

  test("patchSitemapXml populates lastmod for custom and content routes", () => {
    const xml =
      '<?xml version="1.0"?><urlset><url><loc>https://www.domain-sdk.dev/</loc></url><url><loc>https://www.domain-sdk.dev/blog/cloudflare-for-saas</loc><lastmod>2026-11-21</lastmod></url></urlset>';
    const patched = patchSitemapXml(xml, (path) =>
      path === "/" ? "2026-11-04" : path === "/blog/cloudflare-for-saas" ? "2026-11-09" : undefined,
    );
    expect(patched).toContain(
      "<loc>https://www.domain-sdk.dev/</loc><lastmod>2026-11-04</lastmod>",
    );
    expect(patched).toContain(
      "<loc>https://www.domain-sdk.dev/blog/cloudflare-for-saas</loc><lastmod>2026-11-09</lastmod>",
    );
  });

  test("createGitDateResolver updates dates when a future commit touches both an article and blume.config.ts", () => {
    const repo = mkdtempSync(join(tmpdir(), "domain-sdk-git-dates-"));
    const git = (args: string[], date: string) =>
      execFileSync("git", args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
        stdio: "ignore",
      });
    try {
      git(["init"], "2026-11-09T12:00:00Z");
      mkdirSync(join(repo, "apps/fumadocs/content/docs"), { recursive: true });
      writeFileSync(join(repo, "apps/fumadocs/package.json"), "{}");
      writeFileSync(join(repo, "apps/fumadocs/content/docs/guide.mdx"), "# Guide\n");
      git(["add", "."], "2026-11-09T12:00:00Z");
      git(["commit", "-m", "legacy docs"], "2026-11-09T12:00:00Z");

      rmSync(join(repo, "apps/fumadocs"), { recursive: true, force: true });
      mkdirSync(join(repo, "apps/docs/content/docs"), { recursive: true });
      writeFileSync(join(repo, "apps/docs/blume.config.ts"), "export default {};\n");
      writeFileSync(
        join(repo, "apps/docs/content/docs/guide.mdx"),
        '---\nlastModified: "2026-11-09"\n---\n# Guide\n',
      );
      git(["add", "-A"], "2026-11-21T12:00:00Z");
      git(["commit", "-m", "migrate to blume"], "2026-11-21T12:00:00Z");

      // Migration-only lastModified cleanup preserves legacy date.
      writeFileSync(join(repo, "apps/docs/content/docs/guide.mdx"), "---\n---\n# Guide\n");
      git(["add", "-A"], "2026-11-21T13:00:00Z");
      git(["commit", "-m", "strip hardcoded lastModified"], "2026-11-21T13:00:00Z");

      const docsDir = join(repo, "apps/docs");
      expect(createGitDateResolver(docsDir)("/docs/guide")).toBe("2026-11-09");

      // Future commit touching BOTH article and blume.config.ts updates the date.
      writeFileSync(join(repo, "apps/docs/blume.config.ts"), "export default { site: 'x' };\n");
      writeFileSync(join(repo, "apps/docs/content/docs/guide.mdx"), "---\n---\n# Updated Guide\n");
      git(["add", "-A"], "2026-11-22T12:00:00Z");
      git(["commit", "-m", "update guide and config"], "2026-11-22T12:00:00Z");

      expect(createGitDateResolver(docsDir)("/docs/guide")).toBe("2026-11-22");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
