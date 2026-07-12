import { getDomain } from "tldts";

import { DomainSdkError } from "../../core/errors";
import { httpError, readJson, requireString, type Fetch } from "../../core/http";
import type {
  DomainProvider,
  ProviderContext,
  ProviderDomainInput,
  ProviderListInput,
} from "../../core/provider";
import type { DnsRecord, Domain, DomainPage } from "../../core/types";

export interface NetlifyOptions {
  accessToken: string;
  siteId: string;
  fetch?: Fetch;
}

export interface NetlifyProvider extends DomainProvider {
  readonly id: "netlify";
}

interface NetlifySite {
  id?: string;
  name?: string;
  custom_domain?: string | null;
  domain_aliases?: string[];
  url?: string;
  updated_at?: string;
}

interface NetlifyCertificate {
  state?: string;
  domains?: string[];
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
}

interface NetlifyState {
  site: NetlifySite;
  certificate?: NetlifyCertificate;
}

export function netlify(options: NetlifyOptions): NetlifyProvider {
  const accessToken = requireString(options.accessToken, "accessToken", "netlify");
  const siteId = requireString(options.siteId, "siteId", "netlify");
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch)
    throw new DomainSdkError("INVALID_CONFIGURATION", "netlify requires a fetch implementation.", {
      provider: "netlify",
    });

  const request = async <T>(
    path: string,
    context: ProviderContext,
    init?: RequestInit,
    notFoundOkay = false,
  ): Promise<T | undefined> => {
    let response: Response;
    try {
      response = await doFetch(`https://api.netlify.com/api/v1${path}`, {
        ...init,
        signal: context.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          ...init?.headers,
        },
      });
    } catch (error) {
      if (context.signal?.aborted)
        throw new DomainSdkError("ABORTED", "The Netlify request was cancelled.", {
          provider: "netlify",
          cause: error,
        });
      throw new DomainSdkError("PROVIDER_UNAVAILABLE", "Could not reach Netlify.", {
        provider: "netlify",
        retryable: true,
        cause: error,
      });
    }

    const body = await readJson(response);
    if (!response.ok) {
      if (notFoundOkay && response.status === 404) return undefined;
      throw httpError("netlify", response, body, "Netlify rejected the request.");
    }
    return body as T;
  };

  const sitePath = `/sites/${encodeURIComponent(siteId)}`;

  const getState = async (context: ProviderContext): Promise<NetlifyState> => {
    const [site, certificate] = await Promise.all([
      request<NetlifySite>(sitePath, context),
      request<NetlifyCertificate>(`${sitePath}/ssl`, context, undefined, true),
    ]);
    if (
      !site?.id ||
      !site.name ||
      !Array.isArray(site.domain_aliases) ||
      site.domain_aliases.some((alias) => typeof alias !== "string")
    )
      throw new DomainSdkError("REQUEST_FAILED", "Netlify returned an invalid site response.", {
        provider: "netlify",
      });
    if (
      certificate &&
      (typeof certificate.state !== "string" || !Array.isArray(certificate.domains))
    )
      throw new DomainSdkError("REQUEST_FAILED", "Netlify returned an invalid TLS response.", {
        provider: "netlify",
      });
    return { site, certificate };
  };

  const hasAlias = (site: NetlifySite, hostname: string) =>
    site.domain_aliases?.some((alias) => alias.toLowerCase() === hostname) === true;

  const normalize = (hostname: string, state: NetlifyState): Domain => {
    const siteHostname = (() => {
      try {
        return state.site.url ? new URL(state.site.url).hostname : `${state.site.name}.netlify.app`;
      } catch {
        return `${state.site.name}.netlify.app`;
      }
    })();
    const apex = getDomain(hostname, { allowPrivateDomains: true }) === hostname;
    const covered =
      state.certificate?.domains?.some((domain) => {
        const normalized = domain.toLowerCase();
        return (
          normalized === hostname ||
          (normalized.startsWith("*.") && hostname.endsWith(normalized.slice(1)))
        );
      }) === true;
    const certificateState = state.certificate?.state?.toLowerCase();
    const certificateActive =
      covered && ["issued", "active", "ready"].includes(certificateState ?? "");
    const certificateFailed = covered && ["failed", "error"].includes(certificateState ?? "");
    const recordStatus: DnsRecord["status"] = certificateActive ? "valid" : "pending";
    const records: DnsRecord[] = [
      apex
        ? {
            type: "ALIAS",
            name: hostname,
            value: "apex-loadbalancer.netlify.com",
            purpose: "routing",
            required: true,
            status: recordStatus,
            description:
              "Preferred for DNS providers with ALIAS, ANAME, or CNAME-flattening support. Otherwise use an A record to 75.2.60.5.",
          }
        : {
            type: "CNAME",
            name: hostname,
            value: siteHostname,
            purpose: "routing",
            required: true,
            status: recordStatus,
          },
    ];

    return {
      id: `${siteId}:${hostname}`,
      hostname,
      provider: "netlify",
      status: certificateFailed ? "failed" : certificateActive ? "active" : "pending_dns",
      records,
      verification: {
        status: certificateActive ? "verified" : certificateFailed ? "failed" : "pending",
        records: [],
        message: certificateActive
          ? "Netlify includes this alias in the site's active TLS certificate."
          : "Netlify does not expose separate DNS verification state for each domain alias.",
      },
      certificate: {
        status: certificateActive ? "active" : certificateFailed ? "failed" : "pending",
        issuedAt:
          certificateActive && state.certificate?.created_at
            ? new Date(state.certificate.created_at)
            : undefined,
        expiresAt:
          certificateActive && state.certificate?.expires_at
            ? new Date(state.certificate.expires_at)
            : undefined,
      },
      issues: certificateFailed
        ? [
            {
              code: "CERTIFICATE_FAILED",
              message: "Netlify reports a failed TLS certificate for this domain alias.",
              retryable: true,
            },
          ]
        : [],
      updatedAt: state.site.updated_at ? new Date(state.site.updated_at) : undefined,
    };
  };

  const get = async ({ hostname }: ProviderDomainInput, context: ProviderContext) => {
    const state = await getState(context);
    if (!hasAlias(state.site, hostname))
      throw new DomainSdkError(
        "DOMAIN_NOT_FOUND",
        `${hostname} is not a domain alias on this Netlify site.`,
        { provider: "netlify" },
      );
    return normalize(hostname, state);
  };

  const updateAliases = async (
    aliases: string[],
    context: ProviderContext,
  ): Promise<NetlifySite> => {
    const updated = await request<NetlifySite>(sitePath, context, {
      method: "PATCH",
      body: JSON.stringify({ domain_aliases: aliases }),
    });
    if (!updated?.id || !Array.isArray(updated.domain_aliases))
      throw new DomainSdkError("REQUEST_FAILED", "Netlify returned an invalid site update.", {
        provider: "netlify",
      });
    return updated;
  };

  return {
    id: "netlify",
    capabilities: {
      list: true,
      explicitVerification: false,
      managedCertificates: true,
      apexDomains: true,
      wildcardDomains: false,
    },
    async add({ hostname }, context) {
      let state = await getState(context);
      if (hasAlias(state.site, hostname)) return normalize(hostname, state);
      const aliases = [...(state.site.domain_aliases ?? []), hostname];
      state = { ...state, site: await updateAliases(aliases, context) };
      return normalize(hostname, state);
    },
    get,
    async list(input: ProviderListInput, context: ProviderContext): Promise<DomainPage> {
      const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
      if (!Number.isInteger(offset) || offset < 0)
        throw new DomainSdkError("REQUEST_FAILED", "Invalid Netlify list cursor.", {
          provider: "netlify",
        });
      const state = await getState(context);
      const aliases = state.site.domain_aliases ?? [];
      const page = aliases.slice(offset, offset + input.limit);
      const next = offset + page.length;
      return {
        domains: page.map((hostname) => normalize(hostname.toLowerCase(), state)),
        nextCursor: next < aliases.length ? String(next) : undefined,
      };
    },
    async remove({ hostname }, context) {
      const state = await getState(context);
      if (!hasAlias(state.site, hostname)) return;
      await updateAliases(
        (state.site.domain_aliases ?? []).filter((alias) => alias.toLowerCase() !== hostname),
        context,
      );
    },
  };
}
