import {
  absoluteRecordName,
  formatCaaValue,
  parseCaaValue,
  relativeRecordName,
  type DnsProvider,
  type DnsProviderContext,
  type ZoneRecord,
} from "../../core/dns";
import { DomainSdkError, type DomainSdkErrorCode } from "../../core/errors";
import { httpError, readJson, requireString, type Fetch } from "../../core/http";

export interface PorkbunOptions {
  apiKey: string;
  secretApiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
  ttl?: number;
}

interface PorkbunResponse {
  status: string;
  message?: string;
  code?: string;
  records?: PorkbunRecord[];
  ns?: string[];
}

interface PorkbunRecord {
  id: string | number;
  name: string;
  type: string;
  content: string;
  ttl: string | number;
  prio?: string | number | null;
}

const normalizeNameserver = (name: string) => name.toLowerCase().replace(/\.$/, "");
const isPorkbunNameserver = (name: string) => normalizeNameserver(name).endsWith(".porkbun.com");

export function porkbun(options: PorkbunOptions): DnsProvider {
  const apiKey = requireString(options.apiKey, "apiKey", "porkbun");
  const secretApiKey = requireString(options.secretApiKey, "secretApiKey", "porkbun");
  const ttl = options.ttl ?? 600;
  if (!Number.isInteger(ttl) || ttl < 600 || ttl > 86400)
    throw new DomainSdkError(
      "INVALID_CONFIGURATION",
      "porkbun requires a default TTL between 600 and 86400 seconds.",
      { provider: "porkbun" },
    );
  const baseUrl = (options.baseUrl ?? "https://api.porkbun.com/api/json/v3").replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch)
    throw new DomainSdkError("INVALID_CONFIGURATION", "porkbun requires a fetch implementation.", {
      provider: "porkbun",
    });

  const malformedResponse = () =>
    new DomainSdkError("REQUEST_FAILED", "porkbun returned an invalid response.", {
      provider: "porkbun",
    });

  const request = async (
    path: string,
    context: DnsProviderContext,
    fields: Record<string, unknown> = {},
    idempotencyKey?: string,
  ): Promise<PorkbunResponse> => {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        signal: context.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({ ...fields, apikey: apiKey, secretapikey: secretApiKey }),
      });
    } catch {
      if (context.signal?.aborted)
        throw new DomainSdkError("ABORTED", "The porkbun request was cancelled.", {
          provider: "porkbun",
        });
      throw new DomainSdkError("PROVIDER_UNAVAILABLE", "Could not reach porkbun.", {
        provider: "porkbun",
        retryable: true,
      });
    }

    let body: PorkbunResponse | undefined;
    try {
      body = (await readJson(response, 2_000_000)) as PorkbunResponse | undefined;
    } catch {
      if (context.signal?.aborted)
        throw new DomainSdkError("ABORTED", "The porkbun request was cancelled.", {
          provider: "porkbun",
        });
      if (!response.ok)
        throw httpError("porkbun", response, undefined, "porkbun rejected the request.");
      throw malformedResponse();
    }
    if (!response.ok || body?.status === "ERROR") {
      if (idempotencyKey && response.status === 400 && body?.code === "DUPLICATE_RECORD")
        return { status: "SUCCESS" };
      const failure = httpError("porkbun", response, undefined, "porkbun rejected the request.");
      const reason = `${body?.code ?? ""} ${body?.message ?? ""}`.toLowerCase();
      let code: DomainSdkErrorCode = failure.code;
      if (response.status !== 429 && response.status < 500) {
        if (/not opted in|api access|permission|forbidden|access.denied/.test(reason)) {
          code = "PERMISSION_DENIED";
        } else if (
          /invalid.*key|key.*invalid|authentication|unauthorized|invalid.credentials/.test(reason)
        )
          code = "AUTHENTICATION_FAILED";
        else if (/domain.*(not found|does not exist)|domain_not_found/.test(reason))
          code = "DOMAIN_NOT_FOUND";
        else if (/invalid.(configuration|parameter|record)|validation/.test(reason))
          code = "INVALID_CONFIGURATION";
        else if (/rate.limit/.test(reason)) code = "RATE_LIMITED";
      }
      const message =
        code === "PERMISSION_DENIED"
          ? "Enable API Access for this domain in Porkbun's dashboard and check key permissions."
          : "porkbun rejected the request.";
      throw new DomainSdkError(code, message, {
        provider: "porkbun",
        statusCode: response.status,
        retryable: failure.retryable || code === "RATE_LIMITED",
        retryAfter: failure.retryAfter,
      });
    }
    if (body?.status !== "SUCCESS") throw malformedResponse();
    return body;
  };

  return {
    id: "porkbun",
    capabilities: {
      recordTypes: ["A", "AAAA", "CNAME", "ALIAS", "TXT", "CAA"],
      ttl: { min: 600, max: 86400 },
      wholeZoneWrites: false,
      zoneInfo: true,
    },
    async listRecords({ zone }, context): Promise<ZoneRecord[]> {
      const body = await request(`/dns/retrieve/${encodeURIComponent(zone)}`, context);
      if (!Array.isArray(body.records)) throw malformedResponse();
      return body.records.map((record) => {
        if (
          !record ||
          (typeof record.id !== "string" && typeof record.id !== "number") ||
          typeof record.name !== "string" ||
          typeof record.type !== "string" ||
          typeof record.content !== "string" ||
          !Number.isFinite(Number(record.ttl))
        )
          throw malformedResponse();
        const name = absoluteRecordName(record.name, zone);
        const type = record.type.toUpperCase();
        let value = record.content;
        if (type === "CAA") {
          try {
            const caa = parseCaaValue(value);
            value = formatCaaValue(caa.flag, caa.tag, caa.value);
          } catch {}
        }
        return {
          id: String(record.id),
          name,
          type,
          value,
          ttl: Number(record.ttl),
          priority: record.prio == null || record.prio === "" ? undefined : Number(record.prio),
          editable: !(type === "NS" && name === zone && isPorkbunNameserver(value)),
        };
      });
    },
    async createRecords({ zone, records }, context) {
      for (const record of records) {
        const relativeName = relativeRecordName(record.name, zone);
        await request(
          `/dns/create/${encodeURIComponent(zone)}`,
          context,
          {
            name: relativeName === "@" ? "" : relativeName,
            type: record.type,
            content: record.value,
            ttl: record.ttl ?? ttl,
          },
          crypto.randomUUID(),
        );
      }
    },
    async deleteRecords({ zone, records }, context) {
      for (const record of records) requireString(record.id, "a record id for deletion", "porkbun");
      for (const record of records)
        await request(
          `/dns/delete/${encodeURIComponent(zone)}/${encodeURIComponent(record.id!)}`,
          context,
        );
    },
    async getZone({ zone }, context) {
      const body = await request(`/domain/getNs/${encodeURIComponent(zone)}`, context);
      if (!Array.isArray(body.ns) || body.ns.some((name) => typeof name !== "string"))
        throw malformedResponse();
      const nameservers = body.ns.map(normalizeNameserver);
      return {
        name: zone,
        provider: "porkbun",
        authoritative: nameservers.length > 0 && nameservers.every(isPorkbunNameserver),
        nameservers,
      };
    },
  };
}
