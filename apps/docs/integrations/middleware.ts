import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { APIContext, MiddlewareHandler, MiddlewareNext } from "astro";

import { extractFaq, faqPageSchema } from "../lib/faq";

// The approved loop lives at public/og/og-video.mp4, rendered at twice the
// 1200×630 card size.
const VIDEO_PATH = "/og/og-video.mp4";
const VIDEO_WIDTH = 2400;
const VIDEO_HEIGHT = 1260;

/** The five `og:video` tags for a video at `videoUrl` (absolute). */
export const ogVideoTags = (videoUrl: string): string =>
  [
    ["og:video", videoUrl],
    ["og:video:secure_url", videoUrl],
    ["og:video:type", "video/mp4"],
    ["og:video:width", String(VIDEO_WIDTH)],
    ["og:video:height", String(VIDEO_HEIGHT)],
  ]
    .map(([property, content]) => `<meta content="${content}" property="${property}">`)
    .join("");

/**
 * The content file behind a docs or blog route, or `undefined` for any other
 * route. Builds run from the docs app, so paths resolve from the working
 * directory.
 */
export const contentFileFor = ({
  pathname,
  contentRoot,
}: {
  pathname: string;
  contentRoot: string;
}): string | undefined => {
  const route = pathname.replace(/\/+$/, "");
  if (!/^\/(docs|blog)(\/[\w-]+)*$/.test(route)) return undefined;
  const candidates = [join(contentRoot, `${route}.mdx`), join(contentRoot, route, "index.mdx")];
  return candidates.find((file) => existsSync(file));
};

/** The page's Markdown without its frontmatter block. */
const stripFrontmatter = (source: string): string => source.replace(/^---\n[\s\S]*?\n---\n/, "");

/** A `<script>` with the page's FAQPage JSON-LD, or "" when it has no FAQ section. */
export const faqJsonLd = ({ markdown, url }: { markdown: string; url: string }): string => {
  const schema = faqPageSchema({ url, entries: extractFaq(stripFrontmatter(markdown)) });
  if (schema === undefined) return "";
  const json = JSON.stringify({ "@context": "https://schema.org", ...schema }).replace(
    /</g,
    "\\u003c",
  );
  return `<script type="application/ld+json">${json}</script>`;
};

/** The Google Fonts links for the homepage display typeface, placed in `<head>`. */
export const homeFontTags = (): string =>
  [
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400..700&display=swap">',
  ].join("");

/** Extracts the `title` field from MDX frontmatter when present. */
const extractTitle = (source: string): string | undefined => {
  const match = /^---\n[\s\S]*?^title:\s*["']?([^\n"']+)["']?\s*$/m.exec(source);
  return match?.[1]?.trim();
};

const SECTION_LABELS: Record<string, string> = {
  "api-reference": "API reference",
  components: "Components",
  concepts: "Concepts",
  guides: "Guides",
  project: "Project",
  providers: "Providers",
};

/**
 * Builds a complete `BreadcrumbList` item array for docs and blog routes:
 * - `/docs` -> Home > Docs
 * - `/docs/<slug>` -> Home > Docs > <title>
 * - `/docs/<section>/<slug>` -> Home > Docs > <Section> > <title>
 * - `/blog/<slug>` -> Home > Blog > <title>
 */
export const breadcrumbItemsFor = ({
  pathname,
  markdown,
  site,
}: {
  pathname: string;
  markdown: string;
  site: URL;
}): Array<{ "@type": "ListItem"; position: number; name: string; item: string }> => {
  const clean = pathname.replace(/\/+$/, "");
  const segments = clean.split("/").filter(Boolean);
  if (segments.length === 0) return [];

  if (segments[0] === "blog" && segments.length === 1) {
    return [
      { "@type": "ListItem", position: 1, name: "Home", item: new URL("/", site).href },
      { "@type": "ListItem", position: 2, name: "Blog", item: new URL("/blog", site).href },
    ];
  }

  if (segments[0] === "blog" && segments.length === 2) {
    const slug = segments[1] ?? "";
    const label = extractTitle(markdown) ?? slug.replace(/-/g, " ");
    return [
      { "@type": "ListItem", position: 1, name: "Home", item: new URL("/", site).href },
      { "@type": "ListItem", position: 2, name: "Blog", item: new URL("/blog", site).href },
      { "@type": "ListItem", position: 3, name: label, item: new URL(clean, site).href },
    ];
  }

  if (segments[0] !== "docs") return [];

  const items: Array<{ "@type": "ListItem"; position: number; name: string; item: string }> = [
    { "@type": "ListItem", position: 1, name: "Home", item: new URL("/", site).href },
    { "@type": "ListItem", position: 2, name: "Docs", item: new URL("/docs", site).href },
  ];

  if (segments.length === 2) {
    const slug = segments[1] ?? "";
    const label = extractTitle(markdown) ?? SECTION_LABELS[slug] ?? slug.replace(/-/g, " ");
    items.push({
      "@type": "ListItem",
      position: 3,
      name: label,
      item: new URL(clean, site).href,
    });
  } else if (segments.length >= 3) {
    const section = segments[1] ?? "";
    const slug = segments.at(-1) ?? "";
    const sectionLabel = SECTION_LABELS[section] ?? section.replace(/-/g, " ");
    const pageLabel = extractTitle(markdown) ?? slug.replace(/-/g, " ");
    items.push({
      "@type": "ListItem",
      position: 3,
      name: sectionLabel,
      item: new URL(`/docs/${section}`, site).href,
    });
    items.push({
      "@type": "ListItem",
      position: 4,
      name: pageLabel,
      item: new URL(clean, site).href,
    });
  }

  return items;
};

/**
 * Emits a `BreadcrumbList` JSON-LD script for docs and blog routes.
 */
export const docsBreadcrumbJsonLd = ({
  pathname,
  markdown,
  site,
}: {
  pathname: string;
  markdown: string;
  site: URL;
}): string => {
  const items = breadcrumbItemsFor({ pathname, markdown, site });
  if (items.length === 0) return "";

  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items,
  }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
};

/**
 * Replaces Blume's truncated 2-item `BreadcrumbList` inside `@graph` JSON-LD
 * with the full hierarchy when present, or appends a standalone script otherwise.
 */
export const applyBreadcrumbsToHtml = ({
  html,
  items,
  extraTags,
}: {
  html: string;
  items: ReturnType<typeof breadcrumbItemsFor>;
  extraTags: string;
}): string => {
  if (items.length === 0) {
    return extraTags === "" ? html : html.replace("</head>", `${extraTags}</head>`);
  }

  let replaced = false;
  const updated = html.replace(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    (match, rawJson: string) => {
      if (!rawJson.includes('"BreadcrumbList"')) return match;
      try {
        const parsed = JSON.parse(rawJson) as Record<string, unknown>;
        if (Array.isArray(parsed["@graph"])) {
          let mutated = false;
          parsed["@graph"] = parsed["@graph"].map((node: unknown) => {
            if (
              typeof node === "object" &&
              node !== null &&
              (node as Record<string, unknown>)["@type"] === "BreadcrumbList"
            ) {
              mutated = true;
              return { "@type": "BreadcrumbList", itemListElement: items };
            }
            return node;
          });
          if (mutated) {
            replaced = true;
            return `<script type="application/ld+json">${JSON.stringify(parsed).replace(/</g, "\\u003c")}</script>`;
          }
        }
      } catch {
        // Leave malformed or unexpected JSON-LD blocks untouched.
      }
      return match;
    },
  );

  const fallbackBreadcrumb = replaced
    ? ""
    : `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items,
      }).replace(/</g, "\\u003c")}</script>`;

  const toInject = `${extraTags}${fallbackBreadcrumb}`;
  return toInject === "" ? updated : updated.replace("</head>", `${toInject}</head>`);
};

export const onRequest = (async (
  context: Pick<APIContext, "site" | "url">,
  next: MiddlewareNext,
) => {
  const response = await next();
  const isHtml = response.headers.get("content-type")?.startsWith("text/html") === true;
  if (!isHtml || !context.site) return response;

  const { pathname } = context.url;
  let tags = "";
  let breadcrumbItems: ReturnType<typeof breadcrumbItemsFor> = [];
  if (pathname === "/") {
    tags = `${homeFontTags()}${ogVideoTags(new URL(VIDEO_PATH, context.site).href)}`;
  } else if (pathname === "/blog" || pathname === "/blog/") {
    tags =
      '<link rel="alternate" type="application/rss+xml" title="Domain SDK blog" href="/blog/rss.xml">';
    breadcrumbItems = breadcrumbItemsFor({ pathname, markdown: "", site: context.site });
  } else {
    // Prerendered docs/blog pages read content/ at build time; on-demand routes skip gracefully.
    const file = contentFileFor({ pathname, contentRoot: join(process.cwd(), "content") });
    if (file !== undefined) {
      const markdown = readFileSync(file, "utf8");
      const url = new URL(pathname.replace(/\/+$/, ""), context.site).href;
      tags = faqJsonLd({ markdown, url });
      breadcrumbItems = breadcrumbItemsFor({ pathname, markdown, site: context.site });
    } else {
      breadcrumbItems = breadcrumbItemsFor({ pathname, markdown: "", site: context.site });
    }
  }
  if (tags === "" && breadcrumbItems.length === 0) return response;

  let html = await response.text();
  if (pathname === "/blog" || pathname === "/blog/") {
    html = html.replace(/"@type":"TechArticle"/g, '"@type":"Blog"');
  } else if (pathname === "/sitemap" || pathname === "/sitemap/") {
    html = html.replace(/"@type":"TechArticle"/g, '"@type":"CollectionPage"');
  }
  const nextHtml = applyBreadcrumbsToHtml({ html, items: breadcrumbItems, extraTags: tags });
  return new Response(nextHtml, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}) satisfies MiddlewareHandler;
