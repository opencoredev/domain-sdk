import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocsPageActions } from "@/components/docs-page-actions";
import { getMDXComponents } from "@/components/mdx";
import { gitConfig } from "@/lib/shared";
import { getPageMarkdownUrl, source } from "@/lib/source";
import { socialImageAlt, socialImageSize } from "@/lib/social-image";

export default async function Page(props: PageProps<"/docs/[[...slug]]">) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
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
    openGraph: {
      type: "website",
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
