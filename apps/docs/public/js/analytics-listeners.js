// Site-wide PostHog events for clicks inside Blume's own UI, which the site
// can't attach handlers to. Loaded by the script() analytics adapter in
// blume.config.ts, so it ships only when PostHog does.
// - outbound_link_clicked: links leaving the site (GitHub, npm, chat apps).
// - docs_code_copied: a code block's copy button.
document.addEventListener(
  "click",
  (event) => {
    const posthog = window.posthog;
    if (!posthog || typeof posthog.capture !== "function") return;
    if (!(event.target instanceof Element)) return;

    const anchor = event.target.closest("a[href]");
    if (anchor) {
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin && url.protocol.startsWith("http")) {
        posthog.capture("outbound_link_clicked", {
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
      posthog.capture("docs_code_copied", {
        path: window.location.pathname,
        language: block?.getAttribute("data-language") ?? null,
      });
    }
  },
  true,
);
