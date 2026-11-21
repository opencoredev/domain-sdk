import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface VercelRoute {
  src?: string;
  dest?: string;
  status?: number;
  headers?: Record<string, string>;
  continue?: boolean;
  handle?: string;
}

export interface VercelOutputConfig {
  version: number;
  routes?: VercelRoute[];
  [key: string]: unknown;
}

const INGEST_ROUTE: VercelRoute = {
  src: "^/ingest(?:/(.*))?$",
  dest: "_render",
};

/**
 * Places the `/ingest/*` proxy route ahead of Blume's trailing-slash 308
 * normalization rule so PostHog endpoints like `/ingest/e/` and `/ingest/batch/`
 * reach the Vercel function directly without an extra redirect hop.
 */
export function patchVercelRoutes(config: VercelOutputConfig): VercelOutputConfig {
  if (!Array.isArray(config.routes)) return config;

  const trailingSlashIndex = config.routes.findIndex(
    (route) => route.src === "^/(.*)/$" && route.status === 308,
  );
  if (trailingSlashIndex === -1) return config;

  const existingIngestIndex = config.routes.findIndex(
    (route) => route.src === INGEST_ROUTE.src && route.dest === INGEST_ROUTE.dest,
  );
  if (existingIngestIndex !== -1 && existingIngestIndex < trailingSlashIndex) {
    return config;
  }

  const nextRoutes = [...config.routes];
  nextRoutes.splice(trailingSlashIndex, 0, INGEST_ROUTE);
  return { ...config, routes: nextRoutes };
}

if (import.meta.main) {
  const configPath = resolve(process.cwd(), ".vercel/output/config.json");
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as VercelOutputConfig;
  const patched = patchVercelRoutes(parsed);
  writeFileSync(configPath, `${JSON.stringify(patched, null, "\t")}\n`, "utf8");
}
