import { blogPosts } from "collections/server";
import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";

export const blogRoute = "/blog";
export const blogContentDir = "content/blog";

export const blog = loader({
  baseUrl: blogRoute,
  source: toFumadocsSource(blogPosts, []),
});

export type BlogPost = (typeof blog)["$inferPage"];

/** Every post, newest first. */
export function getBlogPosts(): BlogPost[] {
  return blog
    .getPages()
    .toSorted((a, b) => b.data.date.localeCompare(a.data.date) || a.url.localeCompare(b.url));
}

/** Human-readable date for an ISO `yyyy-mm-dd` frontmatter value. */
export function formatPostDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export async function getBlogLLMText(post: BlogPost) {
  const processed = await post.data.getText("processed");

  return `# ${post.data.title} (${post.url})

${processed}`;
}
