"use client";

import { useEffect } from "react";

import { track } from "@/lib/analytics";

/**
 * Site-wide delegated listeners for interactions that happen inside
 * third-party components (fumadocs UI, portals) we can't attach handlers to:
 * - clicks on links leaving the site (GitHub, npm, ChatGPT/Claude view options, sponsors)
 * - clicks on code-block copy buttons rendered by fumadocs
 */
export function AnalyticsListeners() {
  useEffect(() => {
    function onClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const anchor = target.closest("a");
      if (anchor?.href) {
        const url = new URL(anchor.href, window.location.href);
        if (url.origin !== window.location.origin && url.protocol.startsWith("http")) {
          track("outbound_link_clicked", {
            url: url.href,
            domain: url.hostname,
            text: anchor.textContent?.trim().slice(0, 120) || null,
            path: window.location.pathname,
          });
        }
        return;
      }

      const button = target.closest("button");
      if (button?.closest("figure")?.querySelector("pre code")) {
        const code = button.closest("figure")?.querySelector("code");
        track("docs_code_copied", {
          path: window.location.pathname,
          language: code?.getAttribute("class")?.match(/language-([\w-]+)/)?.[1] ?? null,
        });
      }
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return null;
}
