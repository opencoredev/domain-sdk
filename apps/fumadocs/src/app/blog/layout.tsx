import { HomeLayout } from "fumadocs-ui/layouts/home";

import { baseOptions } from "@/lib/layout.shared";

export default function Layout({ children }: LayoutProps<"/blog">) {
  const options = baseOptions();

  return (
    <div className="domain-docs-shell">
      <HomeLayout
        {...options}
        links={[
          { text: "Docs", url: "/docs" },
          { text: "Blog", url: "/blog", active: "nested-url" },
          ...(options.links ?? []),
        ]}
      >
        {children}
      </HomeLayout>
    </div>
  );
}
