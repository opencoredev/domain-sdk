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

export interface BunnyOptions {
  apiKey: string;
  pullZoneId: string | number;
  /**
   * Allow DNS-01 validation when a Bunny DNS zone exists for the hostname. Wildcard
   * hostnames can only be validated over DNS-01 and always use it.
   */
  allowDnsValidation?: boolean;
  /** Redirect HTTP to HTTPS for the hostname once `verify()` has issued its certificate. */
  forceSsl?: boolean;
  fetch?: Fetch;
}

export interface BunnyProvider extends DomainProvider {
  readonly id: "bunny";
}

/** 0 = Unknown, 1 = Http01, 2 = Dns01, 3 = Custom, 4 = Managed. */
type BunnyCertificateProvisionType = 0 | 1 | 2 | 3 | 4;

interface BunnyHostname {
  Id?: number;
  Value?: string | null;
  ForceSSL?: boolean;
  IsSystemHostname?: boolean;
  HasCertificate?: boolean;
  CertificateProvisionType?: BunnyCertificateProvisionType;
}

/** A hostname the pull zone actually exposes, rather than bunny.net's own system hostname. */
type BunnyCustomHostname = BunnyHostname & { Value: string };

interface BunnyPullZone {
  Id?: number;
  Name?: string | null;
  Hostnames?: BunnyHostname[] | null;
}

interface BunnyApiError {
  ErrorKey?: string | null;
  Field?: string | null;
  Message?: string | null;
}

const CERTIFICATE_ISSUERS: Partial<Record<BunnyCertificateProvisionType, string>> = {
  1: "Let's Encrypt",
  2: "Let's Encrypt",
  4: "bunny.net",
};

export function bunny(options: BunnyOptions): BunnyProvider {
  const apiKey = requireString(options.apiKey, "apiKey", "bunny");
  const pullZoneId = requireString(options.pullZoneId?.toString(), "pullZoneId", "bunny").trim();
  if (!/^\d+$/.test(pullZoneId))
    throw new DomainSdkError("INVALID_CONFIGURATION", "bunny requires a numeric pullZoneId.", {
      provider: "bunny",
    });
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch)
    throw new DomainSdkError("INVALID_CONFIGURATION", "bunny requires a fetch implementation.", {
      provider: "bunny",
    });

  const request = async <T>(
    path: string,
    context: ProviderContext,
    init?: RequestInit,
    notFoundOkay = false,
  ): Promise<T | undefined> => {
    let response: Response;
    try {
      response = await doFetch(`https://api.bunny.net${path}`, {
        ...init,
        signal: context.signal,
        headers: {
          accept: "application/json",
          AccessKey: apiKey,
          "content-type": "application/json",
          ...init?.headers,
        },
      });
    } catch (error) {
      if (context.signal?.aborted)
        throw new DomainSdkError("ABORTED", "The bunny.net request was cancelled.", {
          provider: "bunny",
          cause: error,
        });
      throw new DomainSdkError("PROVIDER_UNAVAILABLE", "Could not reach bunny.net.", {
        provider: "bunny",
        retryable: true,
        cause: error,
      });
    }

    const body = await readJson(response);
    if (!response.ok) {
      if (notFoundOkay && response.status === 404) return undefined;
      const failure = body && typeof body === "object" ? (body as BunnyApiError) : undefined;
      throw httpError(
        "bunny",
        response,
        failure?.Message
          ? { error: { message: failure.Message, code: failure.ErrorKey ?? undefined } }
          : body,
        "bunny.net rejected the request.",
      );
    }
    return body as T;
  };

  const pullZonePath = `/pullzone/${pullZoneId}`;

  const getPullZone = async (context: ProviderContext): Promise<BunnyPullZone> => {
    let zone: BunnyPullZone | undefined;
    try {
      zone = await request<BunnyPullZone>(pullZonePath, context);
    } catch (error) {
      // A missing pull zone is a misconfigured adapter, not a missing customer domain.
      if (error instanceof DomainSdkError && error.statusCode === 404)
        throw new DomainSdkError(
          "INVALID_CONFIGURATION",
          `bunny.net has no pull zone with the ID ${pullZoneId}.`,
          { provider: "bunny", statusCode: 404, cause: error },
        );
      throw error;
    }
    if (
      typeof zone?.Id !== "number" ||
      typeof zone.Name !== "string" ||
      !Array.isArray(zone.Hostnames)
    )
      throw new DomainSdkError("REQUEST_FAILED", "bunny.net returned an invalid pull zone.", {
        provider: "bunny",
      });
    return zone;
  };

  /** The `<zone>.b-cdn.net` hostname that customer routing records point at. */
  const systemHostname = (zone: BunnyPullZone): string =>
    zone.Hostnames?.find(
      (hostname) => hostname.IsSystemHostname === true && typeof hostname.Value === "string",
    )?.Value?.toLowerCase() ?? `${zone.Name}.b-cdn.net`;

  const customHostnames = (zone: BunnyPullZone): BunnyCustomHostname[] =>
    (zone.Hostnames ?? []).filter(
      (hostname): hostname is BunnyCustomHostname =>
        hostname.IsSystemHostname !== true && typeof hostname.Value === "string",
    );

  const findHostname = (zone: BunnyPullZone, hostname: string): BunnyCustomHostname | undefined =>
    customHostnames(zone).find((entry) => entry.Value.toLowerCase() === hostname);

  const requireHostname = (zone: BunnyPullZone, hostname: string): BunnyCustomHostname => {
    const raw = findHostname(zone, hostname);
    if (!raw)
      throw new DomainSdkError(
        "DOMAIN_NOT_FOUND",
        `${hostname} is not a hostname on this bunny.net pull zone.`,
        { provider: "bunny" },
      );
    return raw;
  };

  const normalize = (raw: BunnyCustomHostname, zone: BunnyPullZone): Domain => {
    const hostname = raw.Value.toLowerCase();
    const target = systemHostname(zone);
    const certified = raw.HasCertificate === true;
    const recordStatus: DnsRecord["status"] = certified ? "valid" : "pending";
    const apex = getDomain(hostname, { allowPrivateDomains: true }) === hostname;
    const records: DnsRecord[] = [
      apex
        ? {
            type: "ALIAS",
            name: hostname,
            value: target,
            purpose: "routing",
            required: true,
            status: recordStatus,
            description:
              "bunny.net serves apex domains through an ALIAS, ANAME, or flattened CNAME record. It publishes no fixed A record for pull zones, so the DNS host must support one of those record types.",
          }
        : {
            type: "CNAME",
            name: hostname,
            value: target,
            purpose: "routing",
            required: true,
            status: recordStatus,
          },
    ];

    return {
      id: typeof raw.Id === "number" ? String(raw.Id) : `${pullZoneId}:${hostname}`,
      hostname,
      provider: "bunny",
      status: certified ? "active" : "pending_dns",
      records,
      verification: {
        status: certified ? "verified" : "pending",
        records: [],
        message: certified
          ? "bunny.net issued a certificate for this hostname, which confirms the routing record resolved at issuance. bunny.net does not re-check the record afterwards, so this does not prove the hostname still resolves to the pull zone."
          : "bunny.net validates the hostname while issuing its certificate. Call verify() once the routing record resolves.",
      },
      certificate: {
        status: certified ? "active" : "pending",
        issuer: certified ? CERTIFICATE_ISSUERS[raw.CertificateProvisionType ?? 0] : undefined,
        message: certified
          ? undefined
          : "bunny.net issues a free certificate on request once the routing record resolves.",
      },
      issues: [],
    };
  };

  const get = async ({ hostname }: ProviderDomainInput, context: ProviderContext) => {
    const zone = await getPullZone(context);
    return normalize(requireHostname(zone, hostname), zone);
  };

  return {
    id: "bunny",
    capabilities: {
      list: true,
      explicitVerification: true,
      managedCertificates: true,
      apexDomains: true,
      wildcardDomains: true,
    },
    async add({ hostname }, context) {
      const zone = await getPullZone(context);
      const existing = findHostname(zone, hostname);
      if (existing) return normalize(existing, zone);

      // bunny.net rejects a hostname claimed by another zone with a 400 rather than a 409.
      let rejection: DomainSdkError | undefined;
      try {
        await request(`${pullZonePath}/addHostname`, context, {
          method: "POST",
          body: JSON.stringify({ Hostname: hostname }),
        });
      } catch (error) {
        if (!(error instanceof DomainSdkError) || error.statusCode !== 400) throw error;
        rejection = error;
      }

      // addHostname returns no body, so the pull zone is the only source for the new hostname.
      const updated = await getPullZone(context);
      const created = findHostname(updated, hostname);
      if (created) return normalize(created, updated);
      if (rejection)
        throw new DomainSdkError(
          "DOMAIN_CONFLICT",
          `${hostname} is already attached to another bunny.net zone.`,
          { provider: "bunny", statusCode: 400, cause: rejection },
        );
      throw new DomainSdkError(
        "REQUEST_FAILED",
        "bunny.net did not attach the requested hostname to the pull zone.",
        { provider: "bunny" },
      );
    },
    get,
    async list(input: ProviderListInput, context: ProviderContext): Promise<DomainPage> {
      // Match the whole cursor and keep it exact: Number.parseInt reads "1junk" as 1,
      // and Number() rounds digit strings past the safe-integer range.
      const cursor = input.cursor;
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (cursor !== undefined && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(offset)))
        throw new DomainSdkError("REQUEST_FAILED", "Invalid bunny.net list cursor.", {
          provider: "bunny",
        });
      const zone = await getPullZone(context);
      const hostnames = customHostnames(zone);
      const page = hostnames.slice(offset, offset + input.limit);
      const next = offset + page.length;
      return {
        domains: page.map((raw) => normalize(raw, zone)),
        nextCursor: next < hostnames.length ? String(next) : undefined,
      };
    },
    async verify({ hostname }, context) {
      const existing = requireHostname(await getPullZone(context), hostname);

      if (existing.HasCertificate !== true) {
        const query = new URLSearchParams({ hostname });
        if (hostname.startsWith("*.") || options.allowDnsValidation)
          query.set("useOnlyHttp01", "false");
        try {
          await request(`/pullzone/loadFreeCertificate?${query}`, context);
        } catch (error) {
          if (
            error instanceof DomainSdkError &&
            (error.statusCode === 400 || error.statusCode === 404)
          )
            throw new DomainSdkError(
              "VERIFICATION_FAILED",
              `bunny.net could not issue a certificate for ${hostname}. Confirm the routing record resolves before retrying.`,
              { provider: "bunny", statusCode: error.statusCode, retryable: true, cause: error },
            );
          throw error;
        }
      }

      if (options.forceSsl)
        await request(`${pullZonePath}/setForceSSL`, context, {
          method: "POST",
          body: JSON.stringify({ Hostname: hostname, ForceSSL: true }),
        });

      return get({ hostname }, context);
    },
    async remove({ hostname }, context) {
      const zone = await getPullZone(context);
      if (!findHostname(zone, hostname)) return;
      await request(
        `${pullZonePath}/removeHostname`,
        context,
        { method: "DELETE", body: JSON.stringify({ Hostname: hostname }) },
        true,
      );
    },
  };
}
