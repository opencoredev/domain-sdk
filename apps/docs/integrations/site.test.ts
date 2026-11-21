import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { upstreamUrl } from "./ingest";
import { contentFileFor, faqJsonLd, ogVideoTags } from "./middleware";

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
