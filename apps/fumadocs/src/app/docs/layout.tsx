import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function Layout({ children }: LayoutProps<"/docs">) {
  const options = baseOptions();

  return (
    <div className="domain-docs-shell">
      <DocsLayout
        tree={source.getPageTree()}
        {...options}
        links={[{ text: "Blog", url: "/blog" }, ...(options.links ?? [])]}
      >
        {children}
      </DocsLayout>
    </div>
  );
}
