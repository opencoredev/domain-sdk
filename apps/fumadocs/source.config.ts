import { remarkStructureDefaultOptions } from "fumadocs-core/mdx-plugins/remark-structure";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

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

export default defineConfig({
  mdxOptions: {
    remarkStructureOptions: {
      filterElement: (node) =>
        node.name !== "Card" && remarkStructureDefaultOptions.filterElement(node),
    },
  },
});
