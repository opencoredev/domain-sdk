import type { Metadata } from "next";
import Link from "next/link";

import { DomainLogo } from "@/components/domain-logo";
import { legacyDocRoutes } from "@/lib/seo";
import { source } from "@/lib/source";

export const metadata: Metadata = {
  title: "Sitemap",
  description:
    "Browse every Domain SDK guide, provider adapter, concept, component, and TypeScript API reference page.",
  alternates: { canonical: "/sitemap" },
  openGraph: {
    url: "/sitemap",
    title: "Sitemap | Domain SDK",
    description:
      "Browse every Domain SDK guide, provider adapter, concept, component, and TypeScript API reference page.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Sitemap | Domain SDK",
    description:
      "Browse every Domain SDK guide, provider adapter, concept, component, and TypeScript API reference page.",
  },
};

const sectionOrder = [
  "Getting started",
  "Guides",
  "Providers",
  "Components",
  "Concepts",
  "API reference",
  "Project",
] as const;

const sectionNames: Record<string, (typeof sectionOrder)[number]> = {
  guides: "Guides",
  providers: "Providers",
  components: "Components",
  concepts: "Concepts",
  "api-reference": "API reference",
  project: "Project",
};

export default function SitemapPage() {
  const groups = new Map<(typeof sectionOrder)[number], ReturnType<typeof source.getPages>>();
  for (const section of sectionOrder) groups.set(section, []);

  for (const page of source.getPages()) {
    if (legacyDocRoutes.has(page.url)) continue;
    const section = sectionNames[page.slugs[0] ?? ""] ?? "Getting started";
    groups.get(section)?.push(page);
  }

  for (const pages of groups.values()) {
    pages.sort(
      (a, b) => a.slugs.length - b.slugs.length || a.data.title.localeCompare(b.data.title),
    );
  }

  return (
    <main className="min-h-screen bg-[#f3f1e8] px-5 py-6 text-[#151515] sm:px-8 sm:py-8">
      <div className="mx-auto max-w-6xl">
        <nav className="mb-20 flex items-center justify-between" aria-label="Sitemap navigation">
          <Link className="flex items-center gap-2 font-medium" href="/">
            <span className="brand-mark">
              <DomainLogo priority />
            </span>
            <span>Domain SDK</span>
          </Link>
          <Link className="text-sm underline underline-offset-4" href="/docs">
            Documentation
          </Link>
        </nav>

        <header className="mb-14 max-w-3xl">
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-[#6d6a60]">
            Site index
          </p>
          <h1 className="font-[var(--font-outfit)] text-5xl font-semibold tracking-[-0.04em] sm:text-7xl">
            Sitemap
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-[#5e5b53]">
            Find every guide, supported platform, reusable component, core concept, and TypeScript
            API reference in Domain SDK.
          </p>
        </header>

        <div className="grid gap-x-10 gap-y-14 md:grid-cols-2 lg:grid-cols-3">
          {sectionOrder.map((section) => (
            <section key={section} aria-labelledby={`section-${section.replaceAll(" ", "-")}`}>
              <h2
                className="mb-4 border-b border-[#cbc7ba] pb-3 font-[var(--font-outfit)] text-xl font-semibold"
                id={`section-${section.replaceAll(" ", "-")}`}
              >
                {section}
              </h2>
              <ul className="space-y-3">
                {groups.get(section)?.map((page) => (
                  <li key={page.url}>
                    <Link className="group block" href={page.url}>
                      <span className="font-medium group-hover:underline group-hover:underline-offset-4">
                        {page.data.title}
                      </span>
                      <span className="mt-1 block text-sm leading-5 text-[#706d64]">
                        {page.data.description}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="mt-20 flex flex-wrap gap-x-6 gap-y-2 border-t border-[#cbc7ba] pt-6 text-sm text-[#5e5b53]">
          <Link className="hover:text-[#151515]" href="/">
            Home
          </Link>
          <Link className="hover:text-[#151515]" href="/docs/installation">
            Installation
          </Link>
          <Link className="hover:text-[#151515]" href="/docs/providers">
            Provider comparison
          </Link>
          <Link className="hover:text-[#151515]" href="/sitemap.xml">
            XML sitemap
          </Link>
        </footer>
      </div>
    </main>
  );
}
