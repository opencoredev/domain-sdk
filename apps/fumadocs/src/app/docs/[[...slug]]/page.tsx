import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DocsPageActions } from "@/components/docs-page-actions";
import { JsonLd } from "@/components/json-ld";
import { getMDXComponents } from "@/components/mdx";
import { absoluteUrl, pageNameFromSlug } from "@/lib/seo";
import { gitConfig } from "@/lib/shared";
import { getPageMarkdownUrl, source } from "@/lib/source";
import { socialImageAlt, socialImageSize } from "@/lib/social-image";

export default async function Page(props: PageProps<"/docs/[[...slug]]">) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const breadcrumbSegments = page.url.split("/").filter(Boolean);
  const breadcrumbs = [
    { name: "Home", url: "/" },
    ...breadcrumbSegments.map((segment, index) => ({
      name:
        index === breadcrumbSegments.length - 1
          ? page.data.title
          : segment === "docs"
            ? "Documentation"
            : pageNameFromSlug(segment),
      url: `/${breadcrumbSegments.slice(0, index + 1).join("/")}`,
    })),
  ];
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        "@id": absoluteUrl(`${page.url}#article`),
        headline: page.data.title,
        description: page.data.description,
        url: absoluteUrl(page.url),
        mainEntityOfPage: absoluteUrl(page.url),
        inLanguage: "en-US",
        isPartOf: { "@id": absoluteUrl("/#website") },
        author: { "@id": absoluteUrl("/#organization") },
        publisher: { "@id": absoluteUrl("/#organization") },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: breadcrumbs.map((breadcrumb, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: breadcrumb.name,
          item: absoluteUrl(breadcrumb.url),
        })),
      },
    ],
  };

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <JsonLd data={structuredData} />
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-fd-muted-foreground">
        <ol className="flex flex-wrap items-center gap-1.5">
          {breadcrumbs.map((breadcrumb, index) => (
            <li className="flex items-center gap-1.5" key={breadcrumb.url}>
              {index > 0 && <span aria-hidden="true">/</span>}
              {index === breadcrumbs.length - 1 ? (
                <span aria-current="page">{breadcrumb.name}</span>
              ) : (
                <Link className="hover:text-fd-foreground" href={breadcrumb.url}>
                  {breadcrumb.name}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <DocsPageActions
        markdownUrl={markdownUrl}
        githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/apps/fumadocs/content/docs/${page.path}`}
        pagePath={page.url}
      />
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
    openGraph: {
      type: "website",
      url: page.url,
      title: page.data.title,
      description: page.data.description,
      siteName: "Domain SDK",
      images: [
        {
          url: "/opengraph-image",
          ...socialImageSize,
          alt: socialImageAlt,
          type: "image/png",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: page.data.title,
      description: page.data.description,
      images: [
        {
          url: "/twitter-image",
          ...socialImageSize,
          alt: socialImageAlt,
        },
      ],
    },
  };
}
