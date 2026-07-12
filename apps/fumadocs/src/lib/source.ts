import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { createElement } from "react";

import { isProviderId, ProviderLogo } from "@/components/provider-logo";

import { docsContentRoute, docsImageRoute, docsRoute } from "./shared";

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [],
  icon(icon) {
    return icon && isProviderId(icon) ? createElement(ProviderLogo, { provider: icon }) : undefined;
  },
});

export function getPageImage(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "image.png"];

  return {
    segments,
    url: `${docsImageRoute}/${segments.join("/")}`,
  };
}

export function getPageMarkdownUrl(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "content.md"];

  return {
    segments,
    url: `${docsContentRoute}/${segments.join("/")}`,
  };
}

export async function getLLMText(page: (typeof source)["$inferPage"]) {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})

${processed}`;
}
