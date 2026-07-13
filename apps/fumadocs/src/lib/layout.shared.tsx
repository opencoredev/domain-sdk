import { FavouriteIcon, HistoryIcon, NpmIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { DomainLogo } from "@/components/domain-logo";

import { gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="docs-brand">
          <span className="brand-mark" aria-hidden="true">
            <DomainLogo priority />
          </span>
          <span>Domain SDK</span>
        </span>
      ),
    },
    themeSwitch: {
      enabled: false,
    },
    links: [
      {
        type: "icon",
        label: "View package on npm",
        text: "npm",
        url: "https://www.npmjs.com/package/@opencoredev/domain-sdk",
        external: true,
        icon: <HugeiconsIcon icon={NpmIcon} aria-hidden="true" />,
      },
      {
        type: "icon",
        label: "View changelog",
        text: "Changelog",
        url: "/docs/project/changelog",
        icon: <HugeiconsIcon icon={HistoryIcon} aria-hidden="true" />,
      },
      {
        type: "icon",
        label: "Sponsor Domain SDK",
        text: "Sponsor",
        url: "https://github.com/sponsors/opencoredev",
        external: true,
        icon: <HugeiconsIcon icon={FavouriteIcon} aria-hidden="true" />,
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
