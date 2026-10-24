"use client";
import { Banner } from "fumadocs-ui/components/banner";
import type { MouseEvent } from "react";

import { track } from "@/lib/analytics";

// gradients.sh, tagged so its analytics show which site sent the visitor.
const LAUNCH_POST_URL =
  "https://gradients.sh/?utm_source=domain-sdk.dev&utm_medium=banner&utm_campaign=gradients-launch";

const promo = { project: "gradients-sh", placement: "banner" };

// Fumadocs owns the close button, so catch its click as it bubbles.
function onBannerClick(event: MouseEvent<HTMLDivElement>) {
  if ((event.target as Element).closest("button")) track("cross_promo_dismissed", promo);
}

export function LaunchBanner() {
  return (
    <Banner
      id="gradients-sh-launch"
      height="2.5rem"
      onClick={onBannerClick}
      className="border-b border-[#252522] bg-[#0f0f0e] ps-3 pe-10 text-xs sm:text-sm"
    >
      <a
        href={LAUNCH_POST_URL}
        target="_blank"
        rel="noopener"
        className="truncate text-[#a3a29c] transition-colors hover:text-[#f1efe8]"
        onClick={() => track("cross_promo_clicked", promo)}
      >
        <span className="hidden sm:inline">Hey, Leo here 👋 </span>I just launched{" "}
        <span className="font-semibold text-[#f1efe8] underline underline-offset-4">
          gradients.sh
        </span>
        <span className="hidden sm:inline">, animated gradient backgrounds for React</span>. Come
        check it out →
      </a>
    </Banner>
  );
}
