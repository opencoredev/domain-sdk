"use client";
import { create } from "@orama/orama";
import { useDocsSearch } from "fumadocs-core/search/client";
import { oramaStaticClient } from "fumadocs-core/search/client/orama-static";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { useEffect, useRef } from "react";

import { track } from "@/lib/analytics";

function initOrama() {
  return create({
    schema: { _: "string" },
    // https://docs.orama.com/docs/orama-js/supported-languages
    language: "english",
  });
}

export default function DefaultSearchDialog(props: SharedProps) {
  const { locale } = useI18n(); // (optional) for i18n
  const { search, setSearch, query } = useDocsSearch({
    client: oramaStaticClient({
      initOrama,
      locale,
    }),
  });
  const lastQueried = useRef("");

  useEffect(() => {
    if (props.open) track("docs_search_opened", { path: window.location.pathname });
  }, [props.open]);

  const resultsCount = Array.isArray(query.data) ? query.data.length : 0;
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed.length < 2 || query.isLoading) return;
    const timeout = window.setTimeout(() => {
      if (trimmed === lastQueried.current) return;
      lastQueried.current = trimmed;
      track("docs_search_queried", {
        query: trimmed,
        results_count: resultsCount,
        has_results: resultsCount > 0,
      });
    }, 1000);
    return () => window.clearTimeout(timeout);
  }, [search, query.isLoading, resultsCount]);

  function onResultClick(event: React.MouseEvent) {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    track("docs_search_result_clicked", {
      query: search.trim(),
      result_href: anchor.getAttribute("href"),
    });
  }

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent onClickCapture={onResultClick}>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== "empty" ? query.data : null} />
      </SearchDialogContent>
    </SearchDialog>
  );
}
