import { DomainSdkError } from "../../core/errors";
import { httpError, readJson, requireString, type Fetch } from "../../core/http";
import type {
  DomainProvider,
  ProviderContext,
  ProviderDomainInput,
  ProviderListInput,
} from "../../core/provider";
import { deduplicateRecords, fullRecordName } from "../../core/records";
import type { DnsRecord, Domain, DomainPage } from "../../core/types";

export type CloudflareSslMethod = "http" | "txt";
export type CloudflareSslType = "dv";
export type CloudflareMinimumTlsVersion = "1.0" | "1.1" | "1.2" | "1.3";
export interface CloudflareSaaSOptions {
  apiToken: string;
  zoneId: string;
  cnameTarget: string;
  ssl?: {
    method?: CloudflareSslMethod;
    type?: CloudflareSslType;
    minimumTlsVersion?: CloudflareMinimumTlsVersion;
  };
  customOriginServer?: string;
  fetch?: Fetch;
}
export interface CloudflareSaaSProvider extends DomainProvider {
  readonly id: "cloudflare";
}

interface CfValidationRecord {
  status?: string;
  txt_name?: string;
  txt_value?: string;
  cname?: string;
  cname_target?: string;
  http_url?: string;
  http_body?: string;
}
interface CfHostname {
  id?: string;
  hostname?: string;
  status?: string;
  created_at?: string;
  verification_errors?: string[];
  ownership_verification?: { type?: string; name?: string; value?: string };
  ownership_verification_http?: { http_url?: string; http_body?: string };
  ssl?: {
    status?: string;
    issuer?: string;
    expires_on?: string;
    validation_records?: CfValidationRecord[];
    validation_errors?: { message?: string }[];
  };
}
interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
  result_info?: { page?: number; total_pages?: number };
}

export function cloudflareSaaS(options: CloudflareSaaSOptions): CloudflareSaaSProvider {
  const apiToken = requireString(options.apiToken, "apiToken", "cloudflare");
  const zoneId = requireString(options.zoneId, "zoneId", "cloudflare");
  const cnameTarget = requireString(options.cnameTarget, "cnameTarget", "cloudflare")
    .replace(/\.$/, "")
    .toLowerCase();
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch)
    throw new DomainSdkError(
      "INVALID_CONFIGURATION",
      "cloudflare requires a fetch implementation.",
      { provider: "cloudflare" },
    );
  const base = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames`;
  const request = async <T>(
    path: string,
    context: ProviderContext,
    init?: RequestInit,
    notFoundOkay = false,
  ): Promise<CfEnvelope<T> | undefined> => {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        ...init,
        signal: context.signal,
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
          ...init?.headers,
        },
      });
    } catch (error) {
      if (context.signal?.aborted)
        throw new DomainSdkError("ABORTED", "The Cloudflare request was cancelled.", {
          provider: "cloudflare",
          cause: error,
        });
      throw new DomainSdkError("PROVIDER_UNAVAILABLE", "Could not reach Cloudflare.", {
        provider: "cloudflare",
        retryable: true,
        cause: error,
      });
    }
    const body = await readJson(response);
    if (!response.ok) {
      if (notFoundOkay && response.status === 404) return undefined;
      const envelope = body as CfEnvelope<unknown>;
      const joined = envelope?.errors
        ?.map((item) => item.message)
        .filter(Boolean)
        .join("; ");
      if (response.status === 400 && joined && /(?:fallback|custom) origin/i.test(joined)) {
        throw new DomainSdkError(
          "INVALID_CONFIGURATION",
          `Cloudflare for SaaS origin configuration is invalid: ${joined}`,
          {
            provider: "cloudflare",
            statusCode: response.status,
            details: { errors: envelope.errors },
          },
        );
      }
      throw httpError(
        "cloudflare",
        response,
        joined ? { error: { message: joined, code: envelope.errors?.[0]?.code } } : body,
        "Cloudflare rejected the request.",
      );
    }
    const envelope = body as CfEnvelope<T>;
    if (!envelope || envelope.success !== true || envelope.result === undefined)
      throw new DomainSdkError("REQUEST_FAILED", "Cloudflare returned an invalid API envelope.", {
        provider: "cloudflare",
      });
    return envelope;
  };
  const normalize = (raw: CfHostname): Domain => {
    if (!raw.id || !raw.hostname || !raw.ssl)
      throw new DomainSdkError(
        "REQUEST_FAILED",
        "Cloudflare returned an invalid custom-hostname response.",
        { provider: "cloudflare" },
      );
    const ownership: DnsRecord[] = [];
    if (raw.ownership_verification?.name && raw.ownership_verification.value)
      ownership.push({
        type: "TXT",
        name: fullRecordName(raw.ownership_verification.name, raw.hostname),
        value: raw.ownership_verification.value,
        purpose: "ownership",
        required: true,
        status: raw.status === "active" ? "valid" : "pending",
      });
    const certificate: DnsRecord[] = [];
    let httpValidation = false;
    for (const record of raw.ssl.validation_records ?? []) {
      const status =
        record.status === "active" || record.status === "valid"
          ? "valid"
          : record.status === "invalid"
            ? "invalid"
            : "pending";
      if (record.txt_name && record.txt_value)
        certificate.push({
          type: "TXT",
          name: fullRecordName(record.txt_name, raw.hostname),
          value: record.txt_value,
          purpose: "certificate",
          required: true,
          status,
        });
      if (record.cname && record.cname_target)
        certificate.push({
          type: "CNAME",
          name: fullRecordName(record.cname, raw.hostname),
          value: record.cname_target,
          purpose: "certificate",
          required: true,
          status,
        });
      if (record.http_url && record.http_body) httpValidation = true;
    }
    const routing: DnsRecord = {
      type: "CNAME",
      name: raw.hostname,
      value: cnameTarget,
      purpose: "routing",
      required: true,
      status: raw.status === "active" ? "valid" : "pending",
    };
    const records = deduplicateRecords([routing, ...ownership, ...certificate]);
    const hostnameActive = raw.status === "active";
    const sslActive = raw.ssl.status === "active";
    const sslFailed = [
      "validation_timed_out",
      "issuance_timed_out",
      "deploying_timed_out",
      "failed",
    ].includes(raw.ssl.status ?? "");
    const failed = raw.status === "moved" || raw.status === "deleted" || sslFailed;
    const status = failed
      ? "failed"
      : !hostnameActive
        ? ownership.length
          ? "pending_verification"
          : "pending_dns"
        : !sslActive
          ? "pending_certificate"
          : "active";
    const issues = [
      ...(raw.verification_errors ?? []).map((message) => ({
        code: "HOSTNAME_VERIFICATION",
        message,
        retryable: true,
      })),
      ...(raw.ssl.validation_errors ?? []).flatMap((item) =>
        item.message
          ? [{ code: "CERTIFICATE_VALIDATION", message: item.message, retryable: true }]
          : [],
      ),
    ];
    return {
      id: raw.id,
      hostname: raw.hostname,
      provider: "cloudflare",
      status,
      records,
      verification: {
        status: hostnameActive ? "verified" : failed ? "failed" : "pending",
        records: ownership,
        message: raw.ownership_verification_http?.http_url
          ? "Cloudflare also provides HTTP ownership validation; inspect the provider dashboard if DNS pre-validation is unsuitable."
          : undefined,
      },
      certificate: {
        status: sslActive ? "active" : sslFailed ? "failed" : "pending",
        issuer: raw.ssl.issuer,
        expiresAt: raw.ssl.expires_on ? new Date(raw.ssl.expires_on) : undefined,
        message: httpValidation
          ? "Cloudflare returned an HTTP certificate-validation method that cannot be represented as a DNS record."
          : undefined,
      },
      issues,
      createdAt: raw.created_at ? new Date(raw.created_at) : undefined,
    };
  };
  const find = async (
    hostname: string,
    context: ProviderContext,
  ): Promise<CfHostname | undefined> => {
    const envelope = await request<CfHostname[]>(
      `?hostname=${encodeURIComponent(hostname)}&per_page=2`,
      context,
    );
    return envelope?.result?.find((item) => item.hostname?.toLowerCase() === hostname);
  };
  const get = async ({ hostname }: ProviderDomainInput, context: ProviderContext) => {
    const summary = await find(hostname, context);
    if (!summary?.id)
      throw new DomainSdkError(
        "DOMAIN_NOT_FOUND",
        `${hostname} is not configured in this Cloudflare zone.`,
        { provider: "cloudflare" },
      );
    const envelope = await request<CfHostname>(`/${encodeURIComponent(summary.id)}`, context);
    return normalize(envelope!.result!);
  };
  return {
    id: "cloudflare",
    capabilities: {
      list: true,
      explicitVerification: false,
      managedCertificates: true,
      apexDomains: false,
      wildcardDomains: false,
    },
    async add({ hostname }, context) {
      const existing = await find(hostname, context);
      if (existing?.id) return get({ hostname }, context);
      const ssl = {
        method: options.ssl?.method ?? "txt",
        type: options.ssl?.type ?? "dv",
        ...(options.ssl?.minimumTlsVersion
          ? { settings: { min_tls_version: options.ssl.minimumTlsVersion } }
          : {}),
      };
      try {
        const envelope = await request<CfHostname>("", context, {
          method: "POST",
          body: JSON.stringify({
            hostname,
            ssl,
            ...(options.customOriginServer
              ? { custom_origin_server: options.customOriginServer }
              : {}),
          }),
        });
        return normalize(envelope!.result!);
      } catch (error) {
        if (
          error instanceof DomainSdkError &&
          (error.statusCode === 409 || error.statusCode === 400)
        ) {
          const sameZone = await find(hostname, context);
          if (sameZone?.id) return get({ hostname }, context);
          throw new DomainSdkError(
            "DOMAIN_CONFLICT",
            `${hostname} is already claimed by another Cloudflare for SaaS resource.`,
            { provider: "cloudflare", cause: error },
          );
        }
        throw error;
      }
    },
    get,
    async list(input: ProviderListInput, context: ProviderContext): Promise<DomainPage> {
      const page = input.cursor ? Number.parseInt(input.cursor, 10) : 1;
      if (!Number.isInteger(page) || page < 1)
        throw new DomainSdkError("REQUEST_FAILED", "Invalid Cloudflare page cursor.", {
          provider: "cloudflare",
        });
      const envelope = await request<CfHostname[]>(
        `?page=${page}&per_page=${input.limit}`,
        context,
      );
      const domains: Domain[] = [];
      for (const summary of envelope!.result!) {
        if (!summary.id) continue;
        const details = await request<CfHostname>(`/${encodeURIComponent(summary.id)}`, context);
        domains.push(normalize(details!.result!));
      }
      const totalPages = envelope?.result_info?.total_pages ?? page;
      return { domains, nextCursor: page < totalPages ? String(page + 1) : undefined };
    },
    async remove({ hostname }, context) {
      const existing = await find(hostname, context);
      if (!existing?.id) return;
      await request(`/${encodeURIComponent(existing.id)}`, context, { method: "DELETE" }, true);
    },
  };
}
