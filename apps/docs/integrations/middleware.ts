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

/**
 * Emits a `BreadcrumbList` JSON-LD script for top-level and depth-2 docs routes
 * where Blume omits breadcrumb JSON-LD (it only generates them at depth >= 3).
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
  const clean = pathname.replace(/\/+$/, "");
  if (clean !== "/docs" && !/^\/docs\/[^/]+$/.test(clean)) return "";

  const items: Array<{ "@type": "ListItem"; position: number; name: string; item: string }> = [
    { "@type": "ListItem", position: 1, name: "Home", item: new URL("/", site).href },
    { "@type": "ListItem", position: 2, name: "Docs", item: new URL("/docs", site).href },
  ];

  if (clean !== "/docs") {
    const slug = clean.slice("/docs/".length);
    const label = extractTitle(markdown) ?? slug.replace(/-/g, " ");
    items.push({
      "@type": "ListItem",
      position: 3,
      name: label,
      item: new URL(clean, site).href,
    });
  }

  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items,
  }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
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
  let breadcrumbTag = "";
  if (pathname === "/") {
    tags = `${homeFontTags()}${ogVideoTags(new URL(VIDEO_PATH, context.site).href)}`;
  } else {
    const file = contentFileFor({ pathname, contentRoot: join(process.cwd(), "content") });
    if (file !== undefined) {
      const markdown = readFileSync(file, "utf8");
      const url = new URL(pathname.replace(/\/+$/, ""), context.site).href;
      tags = faqJsonLd({ markdown, url });
      breadcrumbTag = docsBreadcrumbJsonLd({ pathname, markdown, site: context.site });
    }
  }
  if (tags === "" && breadcrumbTag === "") return response;

  const html = await response.text();
  const combined =
    breadcrumbTag !== "" &&
    !html.includes('"@type":"BreadcrumbList"') &&
    !html.includes('"@type": "BreadcrumbList"')
      ? `${tags}${breadcrumbTag}`
      : tags;
  if (combined === "")
    return new Response(html, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });

  return new Response(html.replace("</head>", `${combined}</head>`), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}) satisfies MiddlewareHandler;
