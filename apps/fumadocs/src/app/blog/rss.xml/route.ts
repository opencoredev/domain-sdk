import { blogRoute, getBlogPosts } from "@/lib/blog";
import { absoluteUrl } from "@/lib/seo";

export const revalidate = false;

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const rssDate = (date: string) => new Date(`${date}T00:00:00Z`).toUTCString();

export function GET() {
  const posts = getBlogPosts();
  const items = posts
    .map(
      (post) => `    <item>
      <title>${escapeXml(post.data.title)}</title>
      <link>${absoluteUrl(post.url)}</link>
      <guid isPermaLink="true">${absoluteUrl(post.url)}</guid>
      <description>${escapeXml(post.data.description)}</description>
      <pubDate>${rssDate(post.data.date)}</pubDate>
    </item>`,
    )
    .join("\n");
  // ISO dates sort as strings, so the max is the most recent publish or update.
  const lastChange = posts
    .map((post) => post.data.updated ?? post.data.date)
    .toSorted()
    .at(-1);

  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Domain SDK blog</title>
    <link>${absoluteUrl(blogRoute)}</link>
    <description>Guides to custom domains for SaaS apps and DNS automation with registrar APIs.</description>
    <language>en-us</language>
    <atom:link href="${absoluteUrl(`${blogRoute}/rss.xml`)}" rel="self" type="application/rss+xml" />${lastChange ? `\n    <lastBuildDate>${rssDate(lastChange)}</lastBuildDate>` : ""}
${items}
  </channel>
</rss>
`;

  return new Response(feed, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
