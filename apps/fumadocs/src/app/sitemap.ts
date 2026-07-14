import type { MetadataRoute } from "next";

import { legacyDocRoutes, siteConfig } from "@/lib/seo";
import { source } from "@/lib/source";

function routePriority(url: string) {
  if (url === "/") return 1;
  if (url === "/docs" || url === "/docs/installation" || url === "/docs/providers") return 0.9;
  if (
    url === "/docs/guides" ||
    url === "/docs/components" ||
    url === "/docs/concepts" ||
    url === "/docs/api-reference"
  )
    return 0.8;
  if (url.startsWith("/docs/providers/") || url.startsWith("/docs/guides/")) return 0.8;
  if (url.startsWith("/docs/concepts/") || url.startsWith("/docs/components/")) return 0.7;
  if (url.startsWith("/docs/api-reference/")) return 0.6;
  if (url.startsWith("/docs/project/")) return 0.4;
  return 0.5;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["/", "/sitemap", ...source.getPages().map((page) => page.url)]
    .filter((url, index, all) => !legacyDocRoutes.has(url) && all.indexOf(url) === index)
    .sort((a, b) => a.localeCompare(b));

  return routes.map((url) => ({
    url: new URL(url, siteConfig.url).toString(),
    changeFrequency:
      url === "/" ? "weekly" : url.startsWith("/docs/project/") ? "yearly" : "monthly",
    priority: routePriority(url),
  }));
}
