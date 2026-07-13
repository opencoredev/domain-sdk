"use client";

import { MarkdownCopyButton, ViewOptionsPopover } from "fumadocs-ui/layouts/docs/page";

import { track } from "@/lib/analytics";

export function DocsPageActions({
  markdownUrl,
  githubUrl,
  pagePath,
}: {
  markdownUrl: string;
  githubUrl: string;
  pagePath: string;
}) {
  return (
    <div className="flex flex-row gap-2 items-center border-b pb-6">
      <span
        onClickCapture={() =>
          track("docs_markdown_copied", { page: pagePath, markdown_url: markdownUrl })
        }
      >
        <MarkdownCopyButton markdownUrl={markdownUrl} />
      </span>
      <span onClickCapture={() => track("docs_view_options_opened", { page: pagePath })}>
        <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={githubUrl} />
      </span>
    </div>
  );
}
