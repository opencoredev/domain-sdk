// Site-wide PostHog events for clicks and searches inside Blume's own UI,
// which the site can't attach handlers to directly. Loaded by the script()
// analytics adapter in blume.config.ts, so it ships only when PostHog does.
(() => {
  const capture = (name, props) => {
    const posthog = window.posthog;
    if (!posthog || typeof posthog.capture !== "function") return;
    posthog.capture(name, props);
  };

  let searchTimer;

  document.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;

      const searchResult = event.target.closest("[data-blume-search-results] a[href]");
      if (searchResult) {
        capture("docs_search_result_clicked", {
          href: searchResult.getAttribute("href"),
          text: searchResult.textContent?.trim().slice(0, 120) || null,
          path: window.location.pathname,
        });
        return;
      }

      const anchor = event.target.closest("a[href]");
      if (anchor) {
        const url = new URL(anchor.href, window.location.href);
        if (url.origin !== window.location.origin && url.protocol.startsWith("http")) {
          capture("outbound_link_clicked", {
            url: url.href,
            domain: url.hostname,
            text: anchor.textContent?.trim().slice(0, 120) || null,
            path: window.location.pathname,
          });
        }
        return;
      }

      const copy = event.target.closest("[data-blume-copy]");
      if (copy) {
        const block =
          copy.closest("[data-language]") ?? copy.parentElement?.querySelector("[data-language]");
        capture("docs_code_copied", {
          path: window.location.pathname,
          language: block?.getAttribute("data-language") ?? null,
        });
        return;
      }

      if (event.target.closest("[data-blume-copy-page]")) {
        capture("docs_markdown_copied", { path: window.location.pathname });
        return;
      }

      if (event.target.closest("[data-blume-view-options], [data-blume-page-actions]")) {
        capture("docs_view_options_opened", { path: window.location.pathname });
        return;
      }

      if (event.target.closest("[data-blume-search-open]")) {
        capture("docs_search_opened", { path: window.location.pathname });
      }
    },
    true,
  );

  document.addEventListener(
    "input",
    (event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      if (!event.target.matches("[data-blume-search-input]")) return;
      const query = event.target.value.trim();
      window.clearTimeout(searchTimer);
      if (!query) return;
      searchTimer = window.setTimeout(() => {
        capture("docs_search_queried", {
          query_length: query.length,
          path: window.location.pathname,
        });
      }, 400);
    },
    true,
  );
})();
