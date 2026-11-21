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
        const tabs = copy.closest("blume-tabs");
        const activePanel = tabs
          ? (Array.from(tabs.querySelectorAll("[data-blume-tab-panel]")).find(
              (panel) =>
                !panel.classList.contains("hidden") &&
                !panel.hasAttribute("hidden") &&
                panel.style.display !== "none" &&
                panel.offsetParent !== null,
            ) ??
            tabs.querySelector(
              '[data-blume-tab-panel]:not(.hidden):not([hidden]):not([style*="display: none"])',
            ))
          : null;
        const block =
          copy.closest("[data-language]") ??
          (activePanel?.matches("[data-language]")
            ? activePanel
            : activePanel?.querySelector("[data-language]")) ??
          copy.parentElement?.querySelector("[data-language]");
        const codeClass = block?.querySelector("code")?.className ?? "";
        const classLang = codeClass.match(/\blanguage-([\w-]+)/)?.[1]?.toLowerCase() ?? null;
        const rawLang =
          block?.getAttribute("data-blume-language") ??
          block?.getAttribute("data-language") ??
          null;
        const langMap = {
          typescript: "ts",
          javascript: "js",
          bash: "bash",
          shell: "sh",
          json: "json",
          tsx: "tsx",
          jsx: "jsx",
          html: "html",
          css: "css",
          yaml: "yaml",
          markdown: "md",
        };
        const candidateLang = (classLang ?? rawLang)?.toLowerCase() ?? null;
        const normalizedLang = candidateLang ? (langMap[candidateLang] ?? candidateLang) : null;
        capture("docs_code_copied", {
          path: window.location.pathname,
          language: normalizedLang,
        });
        return;
      }

      if (event.target.closest("[data-blume-copy-page]")) {
        const page = window.location.pathname;
        capture("docs_markdown_copied", {
          page,
          path: page,
          markdown_url: `${page.replace(/\/+$/, "") || "/index"}.md`,
        });
        return;
      }

      const dropdownSummary = event.target.closest(
        "[data-blume-page-actions] details[data-blume-dropdown] > summary",
      );
      if (dropdownSummary) {
        const details = dropdownSummary.parentElement;
        if (!details || !details.hasAttribute("open")) {
          capture("docs_view_options_opened", { path: window.location.pathname });
        }
        return;
      }

      const dropdownButton = event.target.closest(
        "[data-blume-page-actions] [data-blume-dropdown] > button",
      );
      if (dropdownButton) {
        if (dropdownButton.getAttribute("aria-expanded") !== "true") {
          capture("docs_view_options_opened", { path: window.location.pathname });
        }
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
