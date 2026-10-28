import type { MetadataRoute } from "next";

import { gitLastModified } from "@/lib/last-modified";
import { legacyDocRoutes, siteConfig } from "@/lib/seo";
import { source } from "@/lib/source";

const docsContentDir = "content/docs";

// The files whose last commit is each route's real last content change.
function routeSourcePaths(): Map<string, readonly string[]> {
  const paths = new Map<string, readonly string[]>([
    ["/", ["src/app/(home)"]],
    ["/sitemap", ["src/app/(home)/sitemap", docsContentDir]],
  ]);
  for (const page of source.getPages()) {
    paths.set(page.url, [`${docsContentDir}/${page.path}`]);
  }
  return paths;
}

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

  const sourcePaths = routeSourcePaths();

  return routes.map((url) => {
    const paths = sourcePaths.get(url);
    const lastModified = paths ? gitLastModified(paths) : undefined;

    return {
      url: new URL(url, siteConfig.url).toString(),
      ...(lastModified && { lastModified }),
      changeFrequency:
        url === "/" ? "weekly" : url.startsWith("/docs/project/") ? "yearly" : "monthly",
      priority: routePriority(url),
    };
  });
}
