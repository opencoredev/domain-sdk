"use client";
import { RootProvider } from "fumadocs-ui/provider/next";
import { type ReactNode } from "react";

import { AnalyticsListeners } from "@/components/analytics-listeners";
import { LaunchBanner } from "@/components/launch-banner";
import SearchDialog from "@/components/search";

export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider search={{ SearchDialog }}>
      <AnalyticsListeners />
      <LaunchBanner />
      {children}
    </RootProvider>
  );
}
