import { getBlogLLMText, getBlogPosts } from "@/lib/blog";
import { getLLMText, source } from "@/lib/source";
import { legacyDocRoutes } from "@/lib/seo";

export const revalidate = false;

export async function GET() {
  const scan = source
    .getPages()
    .filter((page) => !legacyDocRoutes.has(page.url))
    .map(getLLMText);
  const scanned = await Promise.all([...scan, ...getBlogPosts().map(getBlogLLMText)]);

  return new Response(scanned.join("\n\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": "noindex",
    },
  });
}
