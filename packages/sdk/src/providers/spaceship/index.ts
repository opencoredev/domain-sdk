import {
  formatCaaValue,
  parseCaaValue,
  relativeRecordName,
  type DnsProvider,
  type DnsProviderContext,
  type DnsRecordInput,
  type ZoneRecord,
} from "../../core/dns";
import { DomainSdkError } from "../../core/errors";
import { httpError, readJson, requireString, type Fetch } from "../../core/http";

export interface SpaceshipOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  fetch?: Fetch;
  ttl?: number;
}

interface SpaceshipRecord {
  type: string;
  name: string;
  ttl: number;
  group?: { type?: string };
  address?: string;
  cname?: string;
  aliasName?: string;
  value?: string;
  flag?: number;
  tag?: string;
  exchange?: string;
  preference?: number;
  nameserver?: string;
  [field: string]: unknown;
}

function recordValue(record: SpaceshipRecord): string {
  switch (record.type.toUpperCase()) {
    case "A":
    case "AAAA":
      return record.address ?? "";
    case "CNAME":
      return record.cname ?? "";
    case "ALIAS":
      return record.aliasName ?? "";
    case "CAA":
      return formatCaaValue(record.flag ?? 0, record.tag ?? "", record.value ?? "");
    case "MX":
      return record.exchange ?? "";
    case "NS":
      return record.nameserver ?? "";
    default:
      return record.value ?? JSON.stringify(recordFields(record));
  }
}

function recordFields(record: SpaceshipRecord): Record<string, unknown> {
  const { type: _type, name: _name, ttl: _ttl, group: _group, ...fields } = record;
  return fields;
}

// A full page holds 100 records whose values may reach 65,535 characters each.
const MAX_RESPONSE_LENGTH = 8_000_000;

/** Spaceship names are always zone-relative, so `example.com` in `example.com` is a child label. */
function absoluteName(name: string, zone: string): string {
  const clean = name.trim().toLowerCase().replace(/\.$/, "");
  return !clean || clean === "@" ? zone : `${clean}.${zone}`;
}

function recordName(record: SpaceshipRecord, zone: string): string {
  let prefix: unknown[] = [];
  switch (record.type.toUpperCase()) {
    case "SRV":
      prefix = [record.service, record.protocol];
      break;
    case "TLSA":
      prefix = [record.port, record.protocol];
      break;
    case "HTTPS":
    case "SVCB":
      prefix = [record.port, record.scheme];
      break;
  }
  return [
    ...prefix.filter((part) => typeof part === "string" && part),
    absoluteName(record.name, zone),
  ]
    .join(".")
    .toLowerCase();
}

function inputFields(record: DnsRecordInput): Record<string, unknown> {
  switch (record.type) {
    case "A":
    case "AAAA":
      return { address: record.value };
    case "CNAME":
      return { cname: record.value };
    case "ALIAS":
      return { aliasName: record.value };
    case "TXT":
      return { value: record.value };
    case "CAA":
      return parseCaaValue(record.value);
    default:
      throw new DomainSdkError("UNSUPPORTED_OPERATION", "Spaceship does not support this type.", {
        provider: "spaceship",
      });
  }
}

export function spaceship(options: SpaceshipOptions): DnsProvider {
  const apiKey = requireString(options.apiKey, "apiKey", "spaceship");
  const apiSecret = requireString(options.apiSecret, "apiSecret", "spaceship");
  const ttl = options.ttl ?? 3600;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600)
    throw new DomainSdkError("INVALID_CONFIGURATION", "Spaceship requires a TTL from 60 to 3600.", {
      provider: "spaceship",
    });
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch)
    throw new DomainSdkError(
      "INVALID_CONFIGURATION",
      "spaceship requires a fetch implementation.",
      {
        provider: "spaceship",
      },
    );
  const baseUrl = (options.baseUrl ?? "https://spaceship.dev/api/v1").replace(/\/$/, "");
  const identities = new WeakMap<ZoneRecord, Record<string, unknown>>();
  const safeMessage = (message: string) =>
    message.split(apiKey).join("[REDACTED]").split(apiSecret).join("[REDACTED]");

  const request = async <T>(
    path: string,
    context: DnsProviderContext,
    init?: RequestInit,
  ): Promise<T> => {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: context.signal,
        headers: {
          "X-API-Key": apiKey,
          "X-API-Secret": apiSecret,
          "content-type": "application/json",
        },
      });
    } catch (error) {
      const aborted =
        context.signal?.aborted || (error instanceof Error && error.name === "AbortError");
      throw new DomainSdkError(
        aborted ? "ABORTED" : "PROVIDER_UNAVAILABLE",
        aborted ? "The Spaceship request was cancelled." : "Could not reach Spaceship.",
        { provider: "spaceship", retryable: !aborted },
      );
    }
    let body: unknown;
    try {
      body = await readJson(response, MAX_RESPONSE_LENGTH);
    } catch (error) {
      if (context.signal?.aborted || (error instanceof Error && error.name === "AbortError"))
        throw new DomainSdkError("ABORTED", "The Spaceship request was cancelled.", {
          provider: "spaceship",
        });
      if (response.ok)
        throw new DomainSdkError("REQUEST_FAILED", "Spaceship returned malformed JSON.", {
          provider: "spaceship",
          statusCode: response.status,
        });
    }
    if (!response.ok) {
      const problem = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const message =
        typeof problem.detail === "string"
          ? problem.detail
          : typeof problem.title === "string"
            ? problem.title
            : "Spaceship rejected the request.";
      const error = httpError("spaceship", response, { message: safeMessage(message) }, message);
      if (response.status === 422)
        throw new DomainSdkError(
          init?.method === "PUT" ? "DOMAIN_CONFLICT" : "INVALID_CONFIGURATION",
          error.message,
          { provider: "spaceship", statusCode: 422 },
        );
      throw error;
    }
    return body as T;
  };

  const recordsPath = (zone: string) => `/dns/records/${encodeURIComponent(zone)}`;

  return {
    id: "spaceship",
    capabilities: {
      recordTypes: ["A", "AAAA", "CNAME", "ALIAS", "TXT", "CAA"],
      ttl: { min: 60, max: 3600 },
      wholeZoneWrites: false,
      zoneInfo: true,
    },
    async listRecords({ zone }, context) {
      const records: ZoneRecord[] = [];
      let skip = 0;
      while (true) {
        const page = await request<{ items: SpaceshipRecord[]; total: number }>(
          `${recordsPath(zone)}?take=100&skip=${skip}`,
          context,
        );
        if (
          !page ||
          !Array.isArray(page.items) ||
          !Number.isInteger(page.total) ||
          page.total < 0 ||
          (!page.items.length && skip < page.total)
        )
          throw new DomainSdkError(
            "REQUEST_FAILED",
            "Spaceship returned an invalid records page.",
            {
              provider: "spaceship",
            },
          );
        for (const item of page.items) {
          if (
            !item ||
            typeof item.type !== "string" ||
            typeof item.name !== "string" ||
            !Number.isFinite(item.ttl)
          )
            throw new DomainSdkError(
              "REQUEST_FAILED",
              "Spaceship returned an invalid DNS record.",
              {
                provider: "spaceship",
              },
            );
          const record: ZoneRecord = {
            type: item.type.toUpperCase(),
            name: recordName(item, zone),
            value: recordValue(item),
            ttl: item.ttl,
            editable: item.group?.type === "custom",
          };
          if (record.type === "MX") record.priority = item.preference;
          identities.set(record, { type: item.type, name: item.name, ...recordFields(item) });
          records.push(record);
        }
        skip += page.items.length;
        if (skip >= page.total) return records;
      }
    },
    async createRecords({ zone, records }, context) {
      if (!records.length) return;
      await request(recordsPath(zone), context, {
        method: "PUT",
        body: JSON.stringify({
          force: false,
          items: records.map((record) => ({
            type: record.type,
            name: relativeRecordName(record.name, zone),
            ttl: record.ttl ?? ttl,
            ...inputFields(record),
          })),
        }),
      });
    },
    async deleteRecords({ zone, records }, context) {
      const items = records
        .filter((record) => record.editable)
        .map((record) => {
          const identity = identities.get(record);
          if (!identity)
            throw new DomainSdkError(
              "INVALID_CONFIGURATION",
              "List Spaceship records before deleting.",
              {
                provider: "spaceship",
              },
            );
          return identity;
        });
      if (!items.length) return;
      await request(recordsPath(zone), context, { method: "DELETE", body: JSON.stringify(items) });
    },
    async getZone({ zone }, context) {
      const domain = await request<{ nameservers: { provider: string; hosts: string[] } }>(
        `/domains/${encodeURIComponent(zone)}`,
        context,
      );
      if (
        !domain?.nameservers ||
        !["basic", "custom"].includes(domain.nameservers.provider) ||
        !Array.isArray(domain.nameservers.hosts) ||
        !domain.nameservers.hosts.every((host) => typeof host === "string")
      )
        throw new DomainSdkError("REQUEST_FAILED", "Spaceship returned invalid nameservers.", {
          provider: "spaceship",
        });
      return {
        name: zone,
        provider: "spaceship",
        authoritative: domain.nameservers.provider === "basic",
        nameservers: domain.nameservers.hosts.map((host) => host.toLowerCase().replace(/\.$/, "")),
      };
    },
  };
}
