import { DomainSdkError } from "../../core/errors";
import { httpError, readJson, requireString, type Fetch } from "../../core/http";
import type {
  DomainProvider,
  ProviderContext,
  ProviderDomainInput,
  ProviderListInput,
} from "../../core/provider";
import { deduplicateRecords, fullRecordName } from "../../core/records";
import type { DnsRecord, DnsRecordType, Domain, DomainPage } from "../../core/types";

export interface VercelOptions {
  token: string;
  projectId: string;
  teamId?: string;
  teamSlug?: string;
  fetch?: Fetch;
}
export interface VercelProvider extends DomainProvider {
  readonly id: "vercel";
}

interface VercelChallenge {
  type?: string;
  domain?: string;
  value?: string;
  reason?: string;
}
interface VercelDomain {
  name?: string;
  apexName?: string;
  projectId?: string;
  verified?: boolean;
  verification?: VercelChallenge[];
  createdAt?: number;
  updatedAt?: number;
}
interface VercelConfig {
  configuredBy?: "A" | "CNAME" | "http" | "dns-01" | null;
  misconfigured?: boolean;
  recommendedIPv4?: { rank?: number; value?: string | string[] }[];
  recommendedCNAME?: { rank?: number; value?: string }[];
}

export function vercel(options: VercelOptions): VercelProvider {
  const token = requireString(options.token, "token", "vercel");
  const projectId = requireString(options.projectId, "projectId", "vercel");
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch)
    throw new DomainSdkError("INVALID_CONFIGURATION", "vercel requires a fetch implementation.", {
      provider: "vercel",
    });
  const query = (extra: Record<string, string> = {}) => {
    const params = new URLSearchParams(extra);
    if (options.teamId) params.set("teamId", options.teamId);
    if (options.teamSlug) params.set("slug", options.teamSlug);
    const encoded = params.toString();
    return encoded ? `?${encoded}` : "";
  };
  const request = async <T>(
    path: string,
    context: ProviderContext,
    init?: RequestInit,
    notFoundOkay = false,
  ): Promise<T | undefined> => {
    let response: Response;
    try {
      response = await doFetch(`https://api.vercel.com${path}`, {
        ...init,
        signal: context.signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...init?.headers,
        },
      });
    } catch (error) {
      if (context.signal?.aborted)
        throw new DomainSdkError("ABORTED", "The Vercel request was cancelled.", {
          provider: "vercel",
          cause: error,
        });
      throw new DomainSdkError("PROVIDER_UNAVAILABLE", "Could not reach Vercel.", {
        provider: "vercel",
        retryable: true,
        cause: error,
      });
    }
    const body = await readJson(response);
    if (!response.ok) {
      if (notFoundOkay && response.status === 404) return undefined;
      throw httpError("vercel", response, body, "Vercel rejected the request.");
    }
    return body as T;
  };
  const config = (hostname: string, context: ProviderContext) =>
    request<VercelConfig>(
      `/v6/domains/${encodeURIComponent(hostname)}/config${query({ projectIdOrName: projectId })}`,
      context,
    );
  const normalize = (raw: VercelDomain, configuration: VercelConfig | undefined): Domain => {
    if (!raw.name || typeof raw.verified !== "boolean")
      throw new DomainSdkError(
        "REQUEST_FAILED",
        "Vercel returned an invalid project-domain response.",
        { provider: "vercel" },
      );
    const ownership: DnsRecord[] = (raw.verification ?? []).flatMap((challenge) => {
      const type = challenge.type?.toUpperCase();
      if (!challenge.domain || !challenge.value || !["TXT", "CNAME"].includes(type ?? ""))
        return [];
      return [
        {
          type: type as DnsRecordType,
          name: fullRecordName(challenge.domain, raw.name!),
          value: challenge.value,
          purpose: "ownership",
          required: true,
          status: raw.verified ? "valid" : "pending",
          description: challenge.reason,
        },
      ];
    });
    const routing: DnsRecord[] = [];
    for (const recommendation of configuration?.recommendedCNAME ?? []) {
      if (recommendation.value)
        routing.push({
          type: "CNAME",
          name: raw.name,
          value: recommendation.value,
          purpose: "routing",
          required: recommendation.rank === 1,
          status: configuration?.misconfigured ? "pending" : "valid",
        });
    }
    for (const recommendation of configuration?.recommendedIPv4 ?? []) {
      const values = Array.isArray(recommendation.value)
        ? recommendation.value
        : recommendation.value
          ? [recommendation.value]
          : [];
      for (const value of values)
        routing.push({
          type: "A",
          name: raw.name,
          value,
          purpose: "routing",
          required: recommendation.rank === 1,
          status: configuration?.misconfigured ? "pending" : "valid",
        });
    }
    const records = deduplicateRecords([...routing, ...ownership]);
    const misconfigured = configuration?.misconfigured === true;
    const status = !raw.verified
      ? ownership.length
        ? "pending_verification"
        : "pending_dns"
      : misconfigured
        ? "misconfigured"
        : configuration
          ? "active"
          : "unknown";
    return {
      id: `${projectId}:${raw.name}`,
      hostname: raw.name,
      provider: "vercel",
      status,
      records,
      verification: { status: raw.verified ? "verified" : "pending", records: ownership },
      certificate: {
        status: status === "active" ? "unknown" : "pending",
        message:
          status === "active"
            ? "Vercel reports valid project-domain configuration; certificate details are not exposed by this API."
            : undefined,
      },
      issues: misconfigured
        ? [
            {
              code: "DNS_MISCONFIGURED",
              message: "Vercel reports that the domain is misconfigured.",
              retryable: true,
            },
          ]
        : [],
      createdAt: typeof raw.createdAt === "number" ? new Date(raw.createdAt) : undefined,
      updatedAt: typeof raw.updatedAt === "number" ? new Date(raw.updatedAt) : undefined,
    };
  };
  const getRaw = (hostname: string, context: ProviderContext, absent = false) =>
    request<VercelDomain>(
      `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}${query()}`,
      context,
      undefined,
      absent,
    );
  const get = async ({ hostname }: ProviderDomainInput, context: ProviderContext) => {
    const [raw, configuration] = await Promise.all([
      getRaw(hostname, context),
      config(hostname, context),
    ]);
    if (!raw)
      throw new DomainSdkError(
        "DOMAIN_NOT_FOUND",
        `${hostname} is not attached to this Vercel project.`,
        { provider: "vercel" },
      );
    return normalize(raw, configuration);
  };
  return {
    id: "vercel",
    capabilities: {
      list: true,
      explicitVerification: true,
      managedCertificates: true,
      apexDomains: true,
      wildcardDomains: false,
    },
    async add({ hostname }, context) {
      try {
        const raw = await request<VercelDomain>(
          `/v10/projects/${encodeURIComponent(projectId)}/domains${query()}`,
          context,
          { method: "POST", body: JSON.stringify({ name: hostname }) },
        );
        return normalize(raw!, await config(hostname, context));
      } catch (error) {
        if (error instanceof DomainSdkError && error.statusCode === 400) {
          const existing = await getRaw(hostname, context, true);
          if (existing?.projectId === projectId)
            return normalize(existing, await config(hostname, context));
          throw new DomainSdkError(
            "DOMAIN_CONFLICT",
            `${hostname} is already attached to another Vercel resource.`,
            { provider: "vercel", cause: error },
          );
        }
        throw error;
      }
    },
    get,
    async list(input: ProviderListInput, context: ProviderContext): Promise<DomainPage> {
      const extra: Record<string, string> = { limit: String(input.limit) };
      if (input.cursor) extra.since = input.cursor;
      const raw = await request<{
        domains?: VercelDomain[];
        pagination?: { next?: number | null };
      }>(`/v9/projects/${encodeURIComponent(projectId)}/domains${query(extra)}`, context);
      if (!raw || !Array.isArray(raw.domains))
        throw new DomainSdkError("REQUEST_FAILED", "Vercel returned an invalid domain list.", {
          provider: "vercel",
        });
      const domains: Domain[] = [];
      for (const item of raw.domains)
        domains.push(normalize(item, item.name ? await config(item.name, context) : undefined));
      return {
        domains,
        nextCursor: raw.pagination?.next ? String(raw.pagination.next) : undefined,
      };
    },
    async verify({ hostname }, context) {
      const raw = await request<VercelDomain>(
        `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}/verify${query()}`,
        context,
        { method: "POST" },
      );
      return normalize(raw!, await config(hostname, context));
    },
    async remove({ hostname }, context) {
      const existing = await getRaw(hostname, context, true);
      if (!existing) return;
      if (existing.projectId !== projectId)
        throw new DomainSdkError(
          "DOMAIN_CONFLICT",
          `${hostname} is attached to another Vercel project.`,
          { provider: "vercel" },
        );
      await request(
        `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}${query()}`,
        context,
        { method: "DELETE" },
      );
    },
  };
}
