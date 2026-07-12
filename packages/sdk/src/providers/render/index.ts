import { DomainSdkError } from "../../core/errors";
import { httpError, readJson, requireString, type Fetch } from "../../core/http";
import type {
  DomainProvider,
  ProviderContext,
  ProviderDomainInput,
  ProviderListInput,
} from "../../core/provider";
import { deduplicateRecords } from "../../core/records";
import type { DnsRecord, Domain, DomainPage } from "../../core/types";

export interface RenderOptions {
  apiKey: string;
  serviceId: string;
  fetch?: Fetch;
}

export interface RenderProvider extends DomainProvider {
  readonly id: "render";
}

interface RenderCustomDomain {
  id?: string;
  name?: string;
  domainType?: "apex" | "subdomain";
  publicSuffix?: string;
  redirectForName?: string;
  verificationStatus?: "verified" | "unverified";
  createdAt?: string;
}

interface RenderCustomDomainPageItem {
  customDomain?: RenderCustomDomain;
  cursor?: string;
}

interface RenderService {
  serviceDetails?: {
    url?: string;
  };
}

export function render(options: RenderOptions): RenderProvider {
  const apiKey = requireString(options.apiKey, "apiKey", "render");
  const serviceId = requireString(options.serviceId, "serviceId", "render");
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch)
    throw new DomainSdkError("INVALID_CONFIGURATION", "render requires a fetch implementation.", {
      provider: "render",
    });

  const request = async <T>(
    path: string,
    context: ProviderContext,
    init?: RequestInit,
    notFoundOkay = false,
  ): Promise<T | undefined> => {
    let response: Response;
    try {
      response = await doFetch(`https://api.render.com/v1${path}`, {
        ...init,
        signal: context.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...init?.headers,
        },
      });
    } catch (error) {
      if (context.signal?.aborted)
        throw new DomainSdkError("ABORTED", "The Render request was cancelled.", {
          provider: "render",
          cause: error,
        });
      throw new DomainSdkError("PROVIDER_UNAVAILABLE", "Could not reach Render.", {
        provider: "render",
        retryable: true,
        cause: error,
      });
    }

    const body = await readJson(response);
    if (!response.ok) {
      if (notFoundOkay && response.status === 404) return undefined;
      throw httpError("render", response, body, "Render rejected the request.");
    }
    return body as T;
  };

  const customDomainPath = (hostname?: string) =>
    `/services/${encodeURIComponent(serviceId)}/custom-domains${
      hostname ? `/${encodeURIComponent(hostname)}` : ""
    }`;

  const getRaw = (hostname: string, context: ProviderContext, absent = false) =>
    request<RenderCustomDomain>(customDomainPath(hostname), context, undefined, absent);

  const getServiceHostname = async (context: ProviderContext): Promise<string> => {
    const raw = await request<RenderService>(`/services/${encodeURIComponent(serviceId)}`, context);
    if (!raw?.serviceDetails?.url)
      throw new DomainSdkError("REQUEST_FAILED", "Render returned an invalid service response.", {
        provider: "render",
      });
    try {
      return new URL(raw.serviceDetails.url).hostname;
    } catch (error) {
      throw new DomainSdkError("REQUEST_FAILED", "Render returned an invalid service URL.", {
        provider: "render",
        cause: error,
      });
    }
  };

  const normalize = (raw: RenderCustomDomain, serviceHostname: string): Domain => {
    if (!raw.id || !raw.name || !raw.domainType || !raw.verificationStatus || !raw.createdAt)
      throw new DomainSdkError(
        "REQUEST_FAILED",
        "Render returned an invalid custom-domain response.",
        { provider: "render" },
      );

    const verified = raw.verificationStatus === "verified";
    const recordStatus: DnsRecord["status"] = verified ? "valid" : "pending";
    const wildcard = raw.name.startsWith("*.");
    const routing: DnsRecord[] = [
      raw.domainType === "apex" && !wildcard
        ? {
            type: "A",
            name: raw.name,
            value: "216.24.57.1",
            purpose: "routing",
            required: true,
            status: recordStatus,
            description:
              "Use an ALIAS, ANAME, or flattened CNAME to the Render service hostname when supported; otherwise use this load-balancer address.",
          }
        : {
            type: "CNAME",
            name: raw.name,
            value: serviceHostname,
            purpose: "routing",
            required: true,
            status: recordStatus,
          },
    ];
    const ownership: DnsRecord[] = wildcard
      ? [
          {
            type: "CNAME",
            name: `_acme-challenge.${raw.name.slice(2)}`,
            value: `${serviceId}.verify.renderdns.com`,
            purpose: "certificate",
            required: true,
            status: recordStatus,
            description: "Allows Render to issue and renew the wildcard TLS certificate.",
          },
          {
            type: "CNAME",
            name: `_cf-custom-hostname.${raw.name.slice(2)}`,
            value: `${serviceId}.hostname.renderdns.com`,
            purpose: "ownership",
            required: true,
            status: recordStatus,
            description: "Allows Render to validate ownership of the wildcard hostname.",
          },
        ]
      : [];
    const records = deduplicateRecords([...routing, ...ownership]);

    return {
      id: raw.id,
      hostname: raw.name,
      provider: "render",
      status: verified ? "active" : "pending_dns",
      records,
      verification: {
        status: verified ? "verified" : "pending",
        records: ownership.filter((record) => record.purpose === "ownership"),
      },
      certificate: {
        status: verified ? "unknown" : "pending",
        message: verified
          ? "Render verified the domain and manages certificate issuance; certificate details are not exposed by this API."
          : undefined,
      },
      issues: [],
      createdAt: new Date(raw.createdAt),
    };
  };

  const get = async ({ hostname }: ProviderDomainInput, context: ProviderContext) => {
    const [raw, serviceHostname] = await Promise.all([
      getRaw(hostname, context),
      getServiceHostname(context),
    ]);
    if (!raw)
      throw new DomainSdkError(
        "DOMAIN_NOT_FOUND",
        `${hostname} is not attached to this Render service.`,
        { provider: "render" },
      );
    return normalize(raw, serviceHostname);
  };

  return {
    id: "render",
    capabilities: {
      list: true,
      explicitVerification: true,
      managedCertificates: true,
      apexDomains: true,
      wildcardDomains: true,
    },
    async add({ hostname }, context) {
      const existing = await getRaw(hostname, context, true);
      if (existing) return normalize(existing, await getServiceHostname(context));

      let raw: RenderCustomDomain[] | undefined;
      try {
        raw = await request<RenderCustomDomain[]>(customDomainPath(), context, {
          method: "POST",
          body: JSON.stringify({ name: hostname }),
        });
      } catch (error) {
        if (error instanceof DomainSdkError && error.code === "DOMAIN_CONFLICT") {
          const conflicted = await getRaw(hostname, context, true);
          if (conflicted) return normalize(conflicted, await getServiceHostname(context));
        }
        throw error;
      }
      if (!Array.isArray(raw))
        throw new DomainSdkError("REQUEST_FAILED", "Render returned an invalid create response.", {
          provider: "render",
        });
      const created = raw.find((item) => item.name?.toLowerCase() === hostname);
      if (!created)
        throw new DomainSdkError(
          "REQUEST_FAILED",
          "Render did not return the requested custom domain.",
          { provider: "render" },
        );
      return normalize(created, await getServiceHostname(context));
    },
    get,
    async list(input: ProviderListInput, context: ProviderContext): Promise<DomainPage> {
      const query = new URLSearchParams({ limit: String(input.limit) });
      if (input.cursor) query.set("cursor", input.cursor);
      const [raw, serviceHostname] = await Promise.all([
        request<RenderCustomDomainPageItem[]>(`${customDomainPath()}?${query}`, context),
        getServiceHostname(context),
      ]);
      if (!Array.isArray(raw) || raw.some((item) => !item.customDomain || !item.cursor))
        throw new DomainSdkError("REQUEST_FAILED", "Render returned an invalid domain list.", {
          provider: "render",
        });
      return {
        domains: raw.map((item) => normalize(item.customDomain!, serviceHostname)),
        nextCursor: raw.length === input.limit ? raw.at(-1)?.cursor : undefined,
      };
    },
    async verify({ hostname }, context) {
      await request(`${customDomainPath(hostname)}/verify`, context, { method: "POST" });
      return get({ hostname }, context);
    },
    async remove({ hostname }, context) {
      await request(customDomainPath(hostname), context, { method: "DELETE" }, true);
    },
  };
}
