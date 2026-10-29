import type { Metadata } from "next";
import Link from "next/link";

import { JsonLd } from "@/components/json-ld";
import { blogRoute, formatPostDate, getBlogPosts } from "@/lib/blog";
import { absoluteUrl, siteConfig } from "@/lib/seo";
import { socialImageAlt, socialImageSize } from "@/lib/social-image";

const title = "Blog";
const description =
  "Guides to custom domains for SaaS apps and DNS automation with registrar APIs, with working TypeScript examples.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: blogRoute,
    types: { "application/rss+xml": [{ url: `${blogRoute}/rss.xml`, title: "Domain SDK blog" }] },
  },
  openGraph: {
    type: "website",
    url: blogRoute,
    title: `${title} | Domain SDK`,
    description,
    siteName: siteConfig.name,
    images: [
      { url: "/opengraph-image", ...socialImageSize, alt: socialImageAlt, type: "image/png" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${title} | Domain SDK`,
    description,
    images: [{ url: "/twitter-image", ...socialImageSize, alt: socialImageAlt }],
  },
};

export default function BlogIndexPage() {
  const posts = getBlogPosts();
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Blog",
        "@id": absoluteUrl(`${blogRoute}#blog`),
        name: "Domain SDK blog",
        description,
        url: absoluteUrl(blogRoute),
        inLanguage: "en-US",
        isPartOf: { "@id": absoluteUrl("/#website") },
        publisher: { "@id": absoluteUrl("/#organization") },
        blogPost: posts.map((post) => ({ "@id": absoluteUrl(`${post.url}#article`) })),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: absoluteUrl("/") },
          { "@type": "ListItem", position: 2, name: "Blog", item: absoluteUrl(blogRoute) },
        ],
      },
    ],
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-14 sm:px-8 sm:py-20">
      <JsonLd data={structuredData} />
      <header className="mb-12">
        <h1 className="font-[var(--font-outfit)] text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">
          Blog
        </h1>
        <p className="mt-4 text-lg leading-8 text-fd-muted-foreground">{description}</p>
      </header>

      <ul className="divide-y divide-fd-border border-y border-fd-border">
        {posts.map((post) => (
          <li key={post.url}>
            <Link className="group block py-7" href={post.url}>
              <time
                className="font-mono text-xs uppercase tracking-[0.14em] text-fd-muted-foreground"
                dateTime={post.data.date}
              >
                {formatPostDate(post.data.date)}
              </time>
              <h2 className="mt-2 text-xl font-semibold tracking-[-0.02em] group-hover:underline group-hover:underline-offset-4">
                {post.data.title}
              </h2>
              <p className="mt-2 leading-7 text-fd-muted-foreground">{post.data.description}</p>
            </Link>
          </li>
        ))}
      </ul>

      <p className="mt-10 text-sm text-fd-muted-foreground">
        Subscribe with the{" "}
        <a
          className="underline underline-offset-4 hover:text-fd-foreground"
          href={`${blogRoute}/rss.xml`}
        >
          RSS feed
        </a>
        , or read the{" "}
        <Link className="underline underline-offset-4 hover:text-fd-foreground" href="/docs">
          documentation
        </Link>
        .
      </p>
    </main>
  );
}
