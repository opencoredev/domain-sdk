import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ALL, upstreamUrl } from "./ingest";
import {
  contentFileFor,
  docsBreadcrumbJsonLd,
  faqJsonLd,
  homeFontTags,
  ogVideoTags,
} from "./middleware";
import { patchVercelRoutes } from "../scripts/patch-vercel-routes";

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

  test("preserves the PostHog origin for double-slash paths", () => {
    const target = upstreamUrl(new URL("https://www.domain-sdk.dev/ingest//example.com/probe?x=1"));
    expect(target.origin).toBe("https://us.i.posthog.com");
    expect(target.pathname).toBe("//example.com/probe");
    expect(target.search).toBe("?x=1");
  });
});

describe("ingest proxy handler", () => {
  test("strips sensitive request headers and upstream set-cookie headers", async () => {
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
      const url = new URL("https://www.domain-sdk.dev/ingest/e/?v=2");
      const request = new Request(url, {
        method: "POST",
        headers: {
          cookie: "session=secret",
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-custom": "keep",
        },
        body: '{"event":"pageview"}',
      });
      const response = await ALL({ request, url } as Parameters<typeof ALL>[0]);
      expect(capturedUrl?.href).toBe("https://us.i.posthog.com/e/?v=2");
      expect(capturedHeaders?.get("cookie")).toBeNull();
      expect(capturedHeaders?.get("authorization")).toBeNull();
      expect(capturedHeaders?.get("host")).toBeNull();
      expect(capturedHeaders?.get("x-custom")).toBe("keep");
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

  test("docsBreadcrumbJsonLd emits BreadcrumbList for depth-1 and depth-2 docs routes only", () => {
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
    expect(
      docsBreadcrumbJsonLd({
        pathname: "/docs/providers/vercel",
        markdown: "---\ntitle: Vercel\n---\n",
        site,
      }),
    ).toBe("");
  });

  test("patchVercelRoutes places /ingest ahead of the trailing-slash 308 rule", () => {
    const patched = patchVercelRoutes({
      version: 3,
      routes: [
        { src: "^(?:/.*)?$", headers: { "x-powered-by": "Blume" }, continue: true },
        { src: "^/(.*)/$", headers: { Location: "/$1" }, status: 308 },
        { src: "^/ingest(?:/(.*?))?$", dest: "_render" },
      ],
    });
    const ingestIdx = patched.routes?.findIndex((route) => route.dest === "_render") ?? -1;
    const slashIdx = patched.routes?.findIndex((route) => route.src === "^/(.*)/$") ?? -1;
    expect(ingestIdx).toBeGreaterThan(-1);
    expect(ingestIdx).toBeLessThan(slashIdx);
  });
});
