import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { MDXComponents } from "mdx/types";

import { LegacyDocRedirect } from "./legacy-doc-redirect";
import { DnsRecordsPreview } from "./dns-records-preview";
import { OneClickDnsPreview } from "./one-click-dns-preview";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Tab,
    Tabs,
    LegacyDocRedirect,
    DnsRecordsPreview,
    OneClickDnsPreview,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
