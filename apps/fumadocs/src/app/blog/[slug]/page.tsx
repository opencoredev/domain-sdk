import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { JsonLd } from "@/components/json-ld";
import { getMDXComponents } from "@/components/mdx";
import { blog, blogRoute, formatPostDate } from "@/lib/blog";
import { absoluteUrl, siteConfig } from "@/lib/seo";
import { socialImageAlt, socialImageSize } from "@/lib/social-image";

export default async function BlogPostPage(props: PageProps<"/blog/[slug]">) {
  const { slug } = await props.params;
  const post = blog.getPage([slug]);
  if (!post) notFound();

  const MDX = post.data.body;
  const modified = post.data.updated ?? post.data.date;
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        "@id": absoluteUrl(`${post.url}#article`),
        headline: post.data.title,
        description: post.data.description,
        url: absoluteUrl(post.url),
        mainEntityOfPage: absoluteUrl(post.url),
        datePublished: post.data.date,
        dateModified: modified,
        inLanguage: "en-US",
        image: absoluteUrl("/opengraph-image"),
        isPartOf: { "@id": absoluteUrl(`${blogRoute}#blog`) },
        author: { "@id": absoluteUrl("/#organization") },
        publisher: { "@id": absoluteUrl("/#organization") },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: absoluteUrl("/") },
          { "@type": "ListItem", position: 2, name: "Blog", item: absoluteUrl(blogRoute) },
          { "@type": "ListItem", position: 3, name: post.data.title, item: absoluteUrl(post.url) },
        ],
      },
    ],
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
      <JsonLd data={structuredData} />
      <nav aria-label="Breadcrumb" className="mb-8 text-sm text-fd-muted-foreground">
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>
            <Link className="hover:text-fd-foreground" href="/">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link className="hover:text-fd-foreground" href={blogRoute}>
              Blog
            </Link>
          </li>
        </ol>
      </nav>
      <article>
        <header className="mb-10 border-b border-fd-border pb-8">
          <h1 className="font-[var(--font-outfit)] text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">
            {post.data.title}
          </h1>
          <p className="mt-4 text-lg leading-8 text-fd-muted-foreground">{post.data.description}</p>
          <p className="mt-5 text-sm text-fd-muted-foreground">
            <time dateTime={post.data.date}>{formatPostDate(post.data.date)}</time>
            {post.data.updated && (
              <>
                {" · Updated "}
                <time dateTime={post.data.updated}>{formatPostDate(post.data.updated)}</time>
              </>
            )}
            {` · ${post.data.author}`}
          </p>
        </header>
        <div className="prose min-w-0">
          <MDX components={getMDXComponents({ a: createRelativeLink(blog, post) })} />
        </div>
      </article>
    </main>
  );
}

export function generateStaticParams() {
  return blog.getPages().map((post) => ({ slug: post.slugs[0] }));
}

export async function generateMetadata(props: PageProps<"/blog/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const post = blog.getPage([slug]);
  if (!post) notFound();

  return {
    title: post.data.title,
    description: post.data.description,
    alternates: { canonical: post.url },
    openGraph: {
      type: "article",
      url: post.url,
      title: post.data.title,
      description: post.data.description,
      siteName: siteConfig.name,
      publishedTime: post.data.date,
      modifiedTime: post.data.updated ?? post.data.date,
      images: [
        { url: "/opengraph-image", ...socialImageSize, alt: socialImageAlt, type: "image/png" },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: post.data.title,
      description: post.data.description,
      images: [{ url: "/twitter-image", ...socialImageSize, alt: socialImageAlt }],
    },
  };
}
