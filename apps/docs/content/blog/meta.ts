import { defineMeta } from "blume";

// Posts are `type: blog` pages, so Blume gives them BlogPosting JSON-LD and
// the /blog/rss.xml feed. The "Blog" tab in blume.config.ts keeps this folder
// out of the docs sidebar; pages/blog/index.astro is the post list.
export default defineMeta({
  title: "Blog",
  icon: "newspaper",
  order: 2,
});
