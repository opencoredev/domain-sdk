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
  ogVideoTags,
  onRequest,
} from "./middleware";
import {
  createGitDateResolver,
  patchMcpDataChunk,
  patchServerEntry,
  patchSitemapXml,
  patchVercelRoutes,
  rewriteHtmlModifiedDates,
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
    expect(
      upstreamUrl(new URL("https://www.domain-sdk.dev/ingest/static/array.js?__ts=1")).href,
    ).toBe("https://us-assets.i.posthog.com/static/array.js");
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

      // Throwing clientAddress getter (as @astrojs/vercel does without x-forwarded-for) must not 500.
      const throwingCtx = {
        request: new Request("https://www.domain-sdk.dev/ingest/flags?__ts=1&v=2", {
          method: "GET",
        }),
        url: new URL("https://www.domain-sdk.dev/ingest/flags?__ts=1&v=2"),
        get clientAddress(): string {
          throw new Error("ClientAddressNotAvailable");
        },
      };
      const noIpResp = await ALL(throwingCtx as unknown as Parameters<typeof ALL>[0]);
      expect(noIpResp.status).toBe(200);
      expect(capturedUrl?.href).toBe("https://us.i.posthog.com/flags/?v=2");
      expect(capturedHeaders?.get("x-forwarded-for")).toBeNull();

      // Invalid IP values fall through to the next valid IP header, or omit x-forwarded-for.
      const fallbackUrl = new URL("https://www.domain-sdk.dev/ingest/e?__ts=1");
      await ALL({
        request: new Request(fallbackUrl, {
          method: "POST",
          headers: {
            "x-vercel-forwarded-for": "not-an-ip; evil=1",
            "x-real-ip": "garbage",
            "x-forwarded-for": "198.51.100.7, 10.0.0.1",
          },
          body: "{}",
        }),
        url: fallbackUrl,
      } as Parameters<typeof ALL>[0]);
      expect(capturedHeaders?.get("x-forwarded-for")).toBe("198.51.100.7");

      await ALL({
        request: new Request(fallbackUrl, {
          method: "POST",
          headers: {
            "x-vercel-forwarded-for": "garbage",
            "x-real-ip": "still-garbage",
            "x-forwarded-for": "not-an-ip",
          },
          body: "{}",
        }),
        url: fallbackUrl,
      } as Parameters<typeof ALL>[0]);
      expect(capturedHeaders?.get("x-forwarded-for")).toBeNull();

      // Upstream fetch failures return 502 instead of an unhandled 500.
      globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      const badGateway = await ALL({
        request: new Request(fallbackUrl, { method: "POST", body: "{}" }),
        url: fallbackUrl,
      } as Parameters<typeof ALL>[0]);
      expect(badGateway.status).toBe(502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("head injection helpers and Vercel route patching", () => {
  test("onRequest rewrites /sitemap to CollectionPage, /blog to Blog, and omits runtime Google Fonts on /", async () => {
    const site = new URL("https://www.domain-sdk.dev");
    const sampleHtml =
      '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"TechArticle","headline":"Page"}]}</script></head><body></body></html>';
    const run = async (pathname: string) => {
      const response = await onRequest(
        { site, url: new URL(pathname, site) },
        async () => new Response(sampleHtml, { headers: { "content-type": "text/html" } }),
      );
      return response.text();
    };

    const sitemapHtml = await run("/sitemap");
    expect(sitemapHtml).toContain('"@type":"CollectionPage"');
    expect(sitemapHtml).not.toContain('"@type":"TechArticle"');

    const blogHtml = await run("/blog");
    expect(blogHtml).toContain('"@type":"Blog"');
    expect(blogHtml).toContain('href="/blog/rss.xml"');

    const homeHtml = await run("/");
    expect(homeHtml).toContain('property="og:video"');
    expect(homeHtml).not.toContain("fonts.googleapis.com");
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
    const noindex = routes.find((route) => route.headers?.["x-robots-tag"] === "noindex");
    expect(noindex?.src).toBe("^/(?:llms(?:-full)?\\.txt|.+\\.mdx?)$");
    expect(new RegExp(noindex!.src!).test("/llms.txt")).toBe(true);
    expect(new RegExp(noindex!.src!).test("/llms-full.txt")).toBe(true);
    expect(new RegExp(noindex!.src!).test("/docs/installation.md")).toBe(true);
    expect(new RegExp(noindex!.src!).test("/docs/installation.mdx")).toBe(true);
    expect(new RegExp(noindex!.src!).test("/docs/installation")).toBe(false);
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

  test("rewriteHtmlModifiedDates syncs JSON-LD, article:modified_time, and visible Last updated time, and strips cleanly when undefined", () => {
    const html =
      '<html><head><meta property="article:modified_time" content="2026-11-21T07:28:14.000Z"><script type="application/ld+json">{"@type":"TechArticle","dateModified":"2026-11-21T07:28:14.000Z","headline":"Test"}</script></head><body><p>Last updated on <time datetime="2026-11-21T07:28:14.000Z">November 21, 2026</time></p></body></html>';
    const next = rewriteHtmlModifiedDates(html, "2026-11-09");
    expect(next).toContain('"dateModified":"2026-11-09T00:00:00.000Z"');
    expect(next).toContain('property="article:modified_time" content="2026-11-09T00:00:00.000Z"');
    expect(next).toContain(
      'Last updated on <time datetime="2026-11-09T00:00:00.000Z">November 9, 2026</time>',
    );

    const stripped = rewriteHtmlModifiedDates(html, undefined);
    expect(stripped).not.toContain("article:modified_time");
    expect(stripped).not.toContain("dateModified");
    expect(stripped).not.toContain("Last updated on");
    const jsonLdMatch = stripped.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
    expect(jsonLdMatch).not.toBeNull();
    expect(JSON.parse(jsonLdMatch![1]!)).toEqual({ "@type": "TechArticle", headline: "Test" });

    const sitemapXml =
      '<?xml version="1.0"?><urlset><url><loc>https://www.domain-sdk.dev/docs/guide</loc><lastmod>2026-11-21</lastmod></url></urlset>';
    expect(patchSitemapXml(sitemapXml, () => undefined)).toBe(
      '<?xml version="1.0"?><urlset><url><loc>https://www.domain-sdk.dev/docs/guide</loc></url></urlset>',
    );
  });

  test("createGitDateResolver returns undefined in a shallow clone", () => {
    const origin = mkdtempSync(join(tmpdir(), "domain-sdk-git-origin-"));
    const shallow = mkdtempSync(join(tmpdir(), "domain-sdk-git-shallow-"));
    const gitEnv = (date: string) => ({
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    try {
      execFileSync("git", ["init"], {
        cwd: origin,
        env: gitEnv("2026-11-09T12:00:00Z"),
        stdio: "ignore",
      });
      mkdirSync(join(origin, "apps/docs/content/docs"), { recursive: true });
      writeFileSync(join(origin, "apps/docs/blume.config.ts"), "export default {};\n");
      writeFileSync(join(origin, "apps/docs/content/docs/guide.mdx"), "# Guide\n");
      execFileSync("git", ["add", "."], {
        cwd: origin,
        env: gitEnv("2026-11-09T12:00:00Z"),
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: origin,
        env: gitEnv("2026-11-09T12:00:00Z"),
        stdio: "ignore",
      });
      writeFileSync(join(origin, "apps/docs/content/docs/guide.mdx"), "# Guide 2\n");
      execFileSync("git", ["add", "."], {
        cwd: origin,
        env: gitEnv("2026-11-10T12:00:00Z"),
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "second"], {
        cwd: origin,
        env: gitEnv("2026-11-10T12:00:00Z"),
        stdio: "ignore",
      });

      execFileSync("git", ["clone", "--depth", "1", `file://${origin}`, shallow], {
        stdio: "ignore",
      });
      expect(createGitDateResolver(join(shallow, "apps/docs"))("/docs/guide")).toBeUndefined();
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  test("patchMcpDataChunk syncs or strips lastModified and blog index emits BreadcrumbList", () => {
    const sample =
      'const d = "{\\"lastModified\\":\\"2026-11-21T02:28:14-05:00\\",\\"locale\\":\\"\\",\\"route\\":\\"/docs/installation\\"}";';
    expect(patchMcpDataChunk(sample, () => "2026-07-12")).toContain(
      '\\"lastModified\\":\\"2026-07-12T00:00:00.000Z\\"',
    );
    const stripped = patchMcpDataChunk(sample, () => undefined);
    expect(stripped).not.toContain("lastModified");
    expect(stripped).toContain('\\"route\\":\\"/docs/installation\\"');

    const blogIndexItems = breadcrumbItemsFor({
      pathname: "/blog",
      markdown: "",
      site: new URL("https://www.domain-sdk.dev"),
    });
    expect(blogIndexItems.map((item) => item.name)).toEqual(["Home", "Blog"]);
  });
});
