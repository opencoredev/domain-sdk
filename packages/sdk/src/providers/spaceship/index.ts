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
import {
  httpError,
  isAbortError,
  isResponseTooLarge,
  readJson,
  rejectedByHost,
  requireString,
  type Fetch,
} from "../../core/http";

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

// A full page holds 100 records whose values may reach 65,535 characters each, and JSON escaping
// can double quotes and backslashes.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Times `listRecords()` starts over when the zone changes between pages. */
const MAX_LIST_RESTARTS = 3;
/** Spaceship accepts at most 500 records per save or delete request. */
const MAX_BATCH = 500;

function batches<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += MAX_BATCH)
    result.push(items.slice(index, index + MAX_BATCH));
  return result;
}

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
      const aborted = context.signal?.aborted || isAbortError(error);
      throw new DomainSdkError(
        aborted ? "ABORTED" : "PROVIDER_UNAVAILABLE",
        aborted ? "The Spaceship request was cancelled." : "Could not reach Spaceship.",
        { provider: "spaceship", retryable: !aborted },
      );
    }
    let body: unknown;
    try {
      body = await readJson(response, MAX_RESPONSE_BYTES, "spaceship", context.signal);
    } catch (error) {
      if (isResponseTooLarge(error)) throw error;
      if (context.signal?.aborted || isAbortError(error))
        throw new DomainSdkError("ABORTED", "The Spaceship request was cancelled.", {
          provider: "spaceship",
        });
      // An error answer whose body broke off still carries its status and Retry-After.
      if (
        error instanceof DomainSdkError &&
        (error.code === "ABORTED" || (error.code === "PROVIDER_UNAVAILABLE" && response.ok))
      )
        throw error;
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
      // With force: false, Spaceship answers a save that clashes with existing records with 422.
      // Other 422s are validation errors.
      if (response.status === 422)
        throw new DomainSdkError(
          init?.method === "PUT" && /conflict|exist/i.test(message)
            ? "DOMAIN_CONFLICT"
            : "INVALID_CONFIGURATION",
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
      let records: ZoneRecord[] = [];
      let previousPages = new Set<string>();
      let passSnapshot: string[] = [];
      let sawCrossPageDuplicate = false;
      let pagesInPass = 0;
      let lastPassSnapshot: string[] | undefined;
      let skip = 0;
      let expectedTotal: number | undefined;
      let restarts = 0;
      const restart = (clearSnapshot = false) => {
        if (++restarts > MAX_LIST_RESTARTS)
          throw new DomainSdkError(
            "PROVIDER_UNAVAILABLE",
            "Spaceship records kept changing while they were listed. Try again.",
            { provider: "spaceship", retryable: true },
          );
        records = [];
        previousPages = new Set<string>();
        passSnapshot = [];
        sawCrossPageDuplicate = false;
        pagesInPass = 0;
        if (clearSnapshot) lastPassSnapshot = undefined;
        skip = 0;
        expectedTotal = undefined;
      };
      while (true) {
        const page = await request<{ items: SpaceshipRecord[]; total: number }>(
          `${recordsPath(zone)}?take=100&skip=${skip}`,
          context,
        );
        if (!page || !Array.isArray(page.items) || !Number.isInteger(page.total) || page.total < 0)
          throw new DomainSdkError(
            "REQUEST_FAILED",
            "Spaceship returned an invalid records page.",
            {
              provider: "spaceship",
            },
          );
        // Pages are offsets, so a record added or deleted between pages shifts every later
        // page and would skip or repeat a record. Start over to get a consistent snapshot.
        if (expectedTotal !== undefined && page.total !== expectedTotal) {
          restart(true);
          continue;
        }
        if ((!page.items.length && skip < page.total) || skip + page.items.length > page.total)
          throw new DomainSdkError(
            "REQUEST_FAILED",
            "Spaceship returned an invalid records page.",
            {
              provider: "spaceship",
            },
          );
        const pageKeys: string[] = [];
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
          const identity = { type: item.type, name: item.name, ...recordFields(item) };
          const key = JSON.stringify(identity);
          // Even when total is unchanged, a record repeating across pages can indicate an
          // offset shift between requests or a static zone with duplicate records. Re-read
          // once and accept the snapshot only if two consecutive full passes match.
          if (previousPages.has(key)) sawCrossPageDuplicate = true;
          pageKeys.push(key);
          passSnapshot.push(JSON.stringify([key, item.ttl, item.group?.type ?? null]));
          identities.set(record, identity);
          records.push(record);
        }
        for (const key of pageKeys) previousPages.add(key);
        pagesInPass += 1;
        expectedTotal = page.total;
        skip += page.items.length;
        if (skip >= page.total) {
          // A delete and an add between pages keep the total and can skip one record while
          // repeating none, so any read spanning pages is only trusted once two full passes match.
          if (sawCrossPageDuplicate || pagesInPass > 1) {
            const matchesPrevious =
              lastPassSnapshot !== undefined &&
              lastPassSnapshot.length === passSnapshot.length &&
              passSnapshot.every((entry, index) => entry === lastPassSnapshot?.[index]);
            if (matchesPrevious) return records;
            lastPassSnapshot = passSnapshot;
            restart();
            continue;
          }
          return records;
        }
      }
    },
    async createRecords({ zone, records }, context) {
      const groups = batches(records);
      for (const [index, group] of groups.entries()) {
        const items = group.map((record) => ({
          type: record.type,
          name: relativeRecordName(record.name, zone),
          ttl: record.ttl ?? ttl,
          ...inputFields(record),
        }));
        try {
          await request(recordsPath(zone), context, {
            method: "PUT",
            body: JSON.stringify({ force: false, items }),
          });
        } catch (error) {
          // After a 4xx Spaceship created nothing in this batch, and later batches were never
          // sent. A failure with no answer or a 5xx may still have created the batch.
          for (const skipped of groups.slice(rejectedByHost(error) ? index : index + 1).flat())
            context.onNotCreated?.(skipped);
          throw error;
        }
      }
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
      for (const batch of batches(items))
        await request(recordsPath(zone), context, {
          method: "DELETE",
          body: JSON.stringify(batch),
        });
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
