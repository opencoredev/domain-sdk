"use client";
import { useStaticSearch } from "fumadocs-core/search/client/orama-static";
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

export default function DefaultSearchDialog(props: SharedProps) {
  const { locale } = useI18n(); // (optional) for i18n
  const { search, onSearchChange, isLoading, data, error } = useStaticSearch({ locale });
  const lastQueried = useRef("");

  useEffect(() => {
    if (props.open) track("docs_search_opened", { path: window.location.pathname });
  }, [props.open]);

  const resultsCount = data?.items.length ?? 0;
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed.length < 2 || isLoading) return;
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
  }, [search, isLoading, resultsCount]);

  function onResultClick(event: React.MouseEvent) {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    track("docs_search_result_clicked", {
      query: search.trim(),
      result_href: anchor.getAttribute("href"),
    });
  }

  return (
    <SearchDialog
      search={search}
      onSearchChange={onSearchChange}
      isLoading={isLoading}
      data={data}
      error={error}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent onClickCapture={onResultClick}>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList />
      </SearchDialogContent>
    </SearchDialog>
  );
}
