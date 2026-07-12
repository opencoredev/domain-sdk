import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { DomainLogo } from "@/components/domain-logo";

import { gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="docs-brand">
          <span className="brand-mark" aria-hidden="true">
            <DomainLogo />
          </span>
          <span>Domain SDK</span>
        </span>
      ),
    },
    themeSwitch: {
      enabled: false,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
