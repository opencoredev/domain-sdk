import { remarkStructureDefaultOptions } from "fumadocs-core/mdx-plugins/remark-structure";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineCollections, defineConfig, defineDocs } from "fumadocs-mdx/config";
import { z } from "zod";

// You can customize Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

// Articles, how-tos, and comparisons live on the blog so the docs stay product reference.
export const blogPosts = defineCollections({
  type: "doc",
  dir: "content/blog",
  schema: pageSchema.extend({
    description: z.string(),
    date: z.iso.date(),
    updated: z.iso.date().optional(),
    author: z.string().default("Domain SDK team"),
  }),
  postprocess: {
    includeProcessedMarkdown: true,
  },
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: {
        light: "github-light",
        dark: "github-dark-default",
      },
    },
    remarkStructureOptions: {
      filterElement: (node) =>
        node.name !== "Card" && remarkStructureDefaultOptions.filterElement(node),
    },
  },
});
