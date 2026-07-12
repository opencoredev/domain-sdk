import { DomainSdkError } from "../../core/errors";
import { httpError, readJson, requireString, type Fetch } from "../../core/http";
import type { DomainProvider, ProviderContext, ProviderListInput } from "../../core/provider";
import { deduplicateRecords, fullRecordName } from "../../core/records";
import type { DnsRecord, Domain, DomainPage } from "../../core/types";
import {
  DOMAINS_QUERY,
  DOMAIN_AVAILABLE_QUERY,
  DOMAIN_CREATE_MUTATION,
  DOMAIN_DELETE_MUTATION,
  DOMAIN_QUERY,
} from "./graphql";

export interface RailwayOptions {
  token: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  targetPort?: number;
  fetch?: Fetch;
}
export interface RailwayProvider extends DomainProvider {
  readonly id: "railway";
}
interface RailwayDnsRecord {
  hostlabel?: string;
  requiredValue?: string;
  currentValue?: string;
  status?: string;
}
interface RailwayDomain {
  id?: string;
  domain?: string;
  status?: {
    verificationToken?: string;
    dnsRecords?: RailwayDnsRecord[];
    certificateStatus?: string;
  };
}
interface GraphqlError {
  message?: string;
  extensions?: Record<string, unknown>;
}
interface GraphqlEnvelope<T> {
  data?: T;
  errors?: GraphqlError[];
}

export function railway(options: RailwayOptions): RailwayProvider {
  const token = requireString(options.token, "token", "railway");
  const projectId = requireString(options.projectId, "projectId", "railway");
  const environmentId = requireString(options.environmentId, "environmentId", "railway");
  const serviceId = requireString(options.serviceId, "serviceId", "railway");
  if (
    options.targetPort !== undefined &&
    (!Number.isInteger(options.targetPort) || options.targetPort < 1 || options.targetPort > 65_535)
  )
    throw new DomainSdkError(
      "INVALID_CONFIGURATION",
      "railway targetPort must be between 1 and 65535.",
      { provider: "railway" },
    );
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch)
    throw new DomainSdkError("INVALID_CONFIGURATION", "railway requires a fetch implementation.", {
      provider: "railway",
    });
  const graphql = async <T>(
    query: string,
    variables: Record<string, unknown>,
    context: ProviderContext,
  ): Promise<T> => {
    let response: Response;
    try {
      response = await doFetch("https://backboard.railway.com/graphql/v2", {
        method: "POST",
        signal: context.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      if (context.signal?.aborted)
        throw new DomainSdkError("ABORTED", "The Railway request was cancelled.", {
          provider: "railway",
          cause: error,
        });
      throw new DomainSdkError("PROVIDER_UNAVAILABLE", "Could not reach Railway.", {
        provider: "railway",
        retryable: true,
        cause: error,
      });
    }
    const body = await readJson(response);
    if (!response.ok) throw httpError("railway", response, body, "Railway rejected the request.");
    const envelope = body as GraphqlEnvelope<T>;
    if (envelope.errors?.length) {
      const message =
        envelope.errors
          .map((error) => error.message)
          .filter(Boolean)
          .join("; ") || "Railway returned a GraphQL error.";
      const lower = message.toLowerCase();
      const code =
        lower.includes("unauth") || lower.includes("not author")
          ? "AUTHENTICATION_FAILED"
          : lower.includes("permission") || lower.includes("forbidden")
            ? "PERMISSION_DENIED"
            : lower.includes("not found")
              ? "DOMAIN_NOT_FOUND"
              : lower.includes("already") || lower.includes("available")
                ? "DOMAIN_CONFLICT"
                : "REQUEST_FAILED";
      throw new DomainSdkError(code, `Railway request failed: ${message}`, {
        provider: "railway",
        details: { errors: envelope.errors },
      });
    }
    if (!envelope.data)
      throw new DomainSdkError("REQUEST_FAILED", "Railway returned no GraphQL data.", {
        provider: "railway",
      });
    return envelope.data;
  };
  const recordStatus = (status?: string): DnsRecord["status"] =>
    status === "VALID"
      ? "valid"
      : status === "INVALID"
        ? "invalid"
        : status === "PENDING"
          ? "pending"
          : "unknown";
  const normalize = (raw: RailwayDomain): Domain => {
    if (!raw.id || !raw.domain || !raw.status)
      throw new DomainSdkError(
        "REQUEST_FAILED",
        "Railway returned an invalid custom-domain response.",
        { provider: "railway" },
      );
    const routing: DnsRecord[] = (raw.status.dnsRecords ?? []).flatMap((record) => {
      if (!record.requiredValue) return [];
      const apex = !record.hostlabel || record.hostlabel === "@" || record.hostlabel === raw.domain;
      const recordName =
        !apex && raw.domain!.startsWith(`${record.hostlabel}.`)
          ? raw.domain!
          : fullRecordName(record.hostlabel ?? "@", raw.domain!);
      return [
        {
          type: apex ? "ALIAS" : "CNAME",
          name: recordName,
          value: record.requiredValue,
          purpose: "routing",
          required: true,
          status: recordStatus(record.status),
          description: apex
            ? "Use CNAME flattening, ALIAS, or ANAME support at your DNS provider."
            : undefined,
        },
      ];
    });
    const ownership: DnsRecord[] = raw.status.verificationToken
      ? [
          {
            type: "TXT",
            name: `_railway-verify.${raw.domain}`,
            value: raw.status.verificationToken,
            purpose: "ownership",
            required: true,
            status: "pending",
            description: "Railway domain ownership verification token.",
          },
        ]
      : [];
    const routingValid = routing.length > 0 && routing.every((record) => record.status === "valid");
    const routingInvalid = routing.some((record) => record.status === "invalid");
    const certificateStatus = raw.status.certificateStatus;
    const certificateActive = certificateStatus === "ISSUED";
    const certificateFailed = certificateStatus === "FAILED";
    // Railway keeps returning verificationToken after creation, so certificate issuance is the authoritative proof that required verification completed.
    const verified = certificateActive;
    const status = routingInvalid
      ? "misconfigured"
      : !routingValid
        ? "pending_dns"
        : certificateFailed
          ? "failed"
          : !verified
            ? "pending_verification"
            : certificateActive
              ? "active"
              : "pending_certificate";
    const records = deduplicateRecords([
      ...routing,
      ...ownership.map((record) => ({
        ...record,
        status: verified ? ("valid" as const) : record.status,
      })),
    ]);
    return {
      id: raw.id,
      hostname: raw.domain,
      provider: "railway",
      status,
      records,
      verification: {
        status: verified ? "verified" : certificateFailed ? "failed" : "pending",
        records: records.filter((record) => record.purpose === "ownership"),
      },
      certificate: {
        status: certificateActive ? "active" : certificateFailed ? "failed" : "pending",
      },
      issues: routingInvalid
        ? [
            {
              code: "DNS_MISCONFIGURED",
              message: "Railway reports an invalid routing DNS record.",
              retryable: true,
            },
          ]
        : [],
    };
  };
  const listRaw = async (context: ProviderContext) => {
    const data = await graphql<{ domains?: { customDomains?: RailwayDomain[] } }>(
      DOMAINS_QUERY,
      { projectId, environmentId, serviceId },
      context,
    );
    if (!Array.isArray(data.domains?.customDomains))
      throw new DomainSdkError("REQUEST_FAILED", "Railway returned an invalid domain list.", {
        provider: "railway",
      });
    return data.domains.customDomains;
  };
  const find = async (hostname: string, context: ProviderContext) =>
    (await listRaw(context)).find((item) => item.domain?.toLowerCase() === hostname);
  const getById = async (id: string, context: ProviderContext) => {
    const data = await graphql<{ customDomain?: RailwayDomain }>(
      DOMAIN_QUERY,
      { id, projectId },
      context,
    );
    if (!data.customDomain)
      throw new DomainSdkError("DOMAIN_NOT_FOUND", "The Railway custom domain was not found.", {
        provider: "railway",
      });
    return normalize(data.customDomain);
  };
  return {
    id: "railway",
    capabilities: {
      list: true,
      explicitVerification: false,
      managedCertificates: true,
      apexDomains: true,
      wildcardDomains: false,
    },
    async add({ hostname }, context) {
      const existing = await find(hostname, context);
      if (existing?.id) return getById(existing.id, context);
      const availability = await graphql<{
        customDomainAvailable?: { available?: boolean; message?: string };
      }>(DOMAIN_AVAILABLE_QUERY, { domain: hostname }, context);
      if (availability.customDomainAvailable?.available !== true)
        throw new DomainSdkError(
          "DOMAIN_CONFLICT",
          availability.customDomainAvailable?.message ||
            `${hostname} cannot be added to this Railway service.`,
          { provider: "railway" },
        );
      const input: Record<string, unknown> = {
        projectId,
        environmentId,
        serviceId,
        domain: hostname,
      };
      if (options.targetPort !== undefined) input.targetPort = options.targetPort;
      const data = await graphql<{ customDomainCreate?: RailwayDomain }>(
        DOMAIN_CREATE_MUTATION,
        { input },
        context,
      );
      if (!data.customDomainCreate)
        throw new DomainSdkError(
          "REQUEST_FAILED",
          "Railway did not return the created custom domain.",
          { provider: "railway" },
        );
      return normalize(data.customDomainCreate);
    },
    async get({ hostname }, context) {
      const existing = await find(hostname, context);
      if (!existing?.id)
        throw new DomainSdkError(
          "DOMAIN_NOT_FOUND",
          `${hostname} is not configured on this Railway service.`,
          { provider: "railway" },
        );
      return getById(existing.id, context);
    },
    async list(input: ProviderListInput, context: ProviderContext): Promise<DomainPage> {
      const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
      if (!Number.isInteger(offset) || offset < 0)
        throw new DomainSdkError("REQUEST_FAILED", "Invalid Railway list cursor.", {
          provider: "railway",
        });
      const raw = await listRaw(context);
      const page = raw.slice(offset, offset + input.limit);
      const domains: Domain[] = [];
      for (const item of page) if (item.id) domains.push(await getById(item.id, context));
      const next = offset + page.length;
      return { domains, nextCursor: next < raw.length ? String(next) : undefined };
    },
    async remove({ hostname }, context) {
      const existing = await find(hostname, context);
      if (!existing?.id) return;
      await graphql(DOMAIN_DELETE_MUTATION, { id: existing.id }, context);
    },
  };
}
