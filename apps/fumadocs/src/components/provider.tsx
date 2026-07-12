"use client";
import { RootProvider } from "fumadocs-ui/provider/next";
import { type ReactNode } from "react";

import { AnalyticsListeners } from "@/components/analytics-listeners";
import SearchDialog from "@/components/search";

export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider search={{ SearchDialog }}>
      <AnalyticsListeners />
      {children}
    </RootProvider>
  );
}
