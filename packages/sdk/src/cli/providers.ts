import { DomainSdkError } from "../core/errors";
import type { Fetch } from "../core/http";
import type { DomainProvider } from "../core/provider";
import { bunny } from "../providers/bunny";
import { cloudflareSaaS } from "../providers/cloudflare";
import { netlify } from "../providers/netlify";
import { railway } from "../providers/railway";
import { render } from "../providers/render";
import { vercel } from "../providers/vercel";

export type CliEnv = Readonly<Record<string, string | undefined>>;

/** Builds a provider from environment variables that `required` has already checked. */
export interface CliProviderFactory {
  /** Environment variables that must be set and non-empty. */
  required: readonly string[];
  create(env: CliEnv, fetch: Fetch | undefined): DomainProvider;
}

const value = (env: CliEnv, name: string): string => env[name]?.trim() ?? "";
const optional = (env: CliEnv, name: string): string | undefined => env[name]?.trim() || undefined;

export const CLI_PROVIDERS: Readonly<Record<string, CliProviderFactory>> = {
  vercel: {
    required: ["VERCEL_TOKEN", "VERCEL_PROJECT_ID"],
    create: (env, fetch) =>
      vercel({
        token: value(env, "VERCEL_TOKEN"),
        projectId: value(env, "VERCEL_PROJECT_ID"),
        teamId: optional(env, "VERCEL_TEAM_ID"),
        teamSlug: optional(env, "VERCEL_TEAM_SLUG"),
        fetch,
      }),
  },
  cloudflare: {
    required: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID", "CLOUDFLARE_CNAME_TARGET"],
    create: (env, fetch) =>
      cloudflareSaaS({
        apiToken: value(env, "CLOUDFLARE_API_TOKEN"),
        zoneId: value(env, "CLOUDFLARE_ZONE_ID"),
        cnameTarget: value(env, "CLOUDFLARE_CNAME_TARGET"),
        fetch,
      }),
  },
  railway: {
    required: [
      "RAILWAY_TOKEN",
      "RAILWAY_PROJECT_ID",
      "RAILWAY_ENVIRONMENT_ID",
      "RAILWAY_SERVICE_ID",
    ],
    create: (env, fetch) => {
      const tokenType = optional(env, "RAILWAY_TOKEN_TYPE");
      if (tokenType !== undefined && tokenType !== "project" && tokenType !== "bearer")
        throw new DomainSdkError(
          "INVALID_CONFIGURATION",
          'RAILWAY_TOKEN_TYPE must be "bearer" or "project".',
          { provider: "railway" },
        );
      return railway({
        token: value(env, "RAILWAY_TOKEN"),
        tokenType,
        projectId: value(env, "RAILWAY_PROJECT_ID"),
        environmentId: value(env, "RAILWAY_ENVIRONMENT_ID"),
        serviceId: value(env, "RAILWAY_SERVICE_ID"),
        fetch,
      });
    },
  },
  render: {
    required: ["RENDER_API_KEY", "RENDER_SERVICE_ID"],
    create: (env, fetch) =>
      render({
        apiKey: value(env, "RENDER_API_KEY"),
        serviceId: value(env, "RENDER_SERVICE_ID"),
        fetch,
      }),
  },
  netlify: {
    required: ["NETLIFY_ACCESS_TOKEN", "NETLIFY_SITE_ID"],
    create: (env, fetch) =>
      netlify({
        accessToken: value(env, "NETLIFY_ACCESS_TOKEN"),
        siteId: value(env, "NETLIFY_SITE_ID"),
        fetch,
      }),
  },
  bunny: {
    required: ["BUNNY_API_KEY", "BUNNY_PULL_ZONE_ID"],
    create: (env, fetch) =>
      bunny({
        apiKey: value(env, "BUNNY_API_KEY"),
        pullZoneId: value(env, "BUNNY_PULL_ZONE_ID"),
        fetch,
      }),
  },
};
