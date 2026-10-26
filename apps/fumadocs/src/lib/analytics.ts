import posthog from "posthog-js";

type EventProperties = Record<string, string | number | boolean | null | undefined>;

/**
 * Central registry of custom events so names stay consistent across the site.
 * Autocapture and pageviews/pageleaves are handled by posthog-js itself.
 */
export type AnalyticsEvent =
  | "cta_clicked"
  | "install_command_copied"
  | "provider_link_clicked"
  | "outbound_link_clicked"
  | "home_section_viewed"
  | "docs_search_opened"
  | "docs_search_queried"
  | "docs_search_result_clicked"
  | "docs_markdown_copied"
  | "docs_view_options_opened"
  | "docs_code_copied"
  | "legacy_doc_redirected";

export function track(event: AnalyticsEvent, properties?: EventProperties) {
  posthog.capture(event, properties);
}
