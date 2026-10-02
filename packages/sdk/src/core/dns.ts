import { getDomain } from "tldts";

import { assertServerEnvironment } from "./client";
import { DomainSdkError, normalizeUnknownError } from "./errors";
import { normalizeHostname } from "./hostname";
import type { DnsRecord, DnsRecordType, Domain, DomainLogger, RequestOptions } from "./types";

/** A record the SDK can write into a DNS zone. */
export interface DnsRecordInput {
  type: DnsRecordType;
  /** Fully qualified owner name inside the zone, or `@` for the zone apex. */
  name: string;
  /** Presentation-format value. CAA uses `0 issue "letsencrypt.org"`. */
  value: string;
  ttl?: number;
}

/** A record read back from a DNS host. */
export interface ZoneRecord {
  /** The DNS host's record id, when it has one. */
  id?: string;
  /** Record type as reported by the DNS host, including types the SDK never writes. */
  type: string;
  /** Lowercase fully qualified owner name without a trailing dot. */
  name: string;
  value: string;
  ttl?: number;
  priority?: number;
  /** `false` for records the DNS host manages itself, which the SDK never changes. */
  editable: boolean;
}

export interface DnsZone {
  /** Lowercase zone apex, for example `example.com`. */
  name: string;
  provider: string;
  /**
   * Whether the zone's delegated nameservers point at this DNS host. Records written to a
   * zone that is not authoritative are saved but never resolve publicly.
   */
  authoritative: boolean;
  nameservers: string[];
}

export interface DnsProviderCapabilities {
  /** Record types this DNS host accepts from the SDK. */
  recordTypes: readonly DnsRecordType[];
  ttl: { min: number; max: number };
  /**
   * `true` when the host only supports replacing the whole zone, so every write is a
   * read-modify-write that can race with edits made elsewhere.
   */
  wholeZoneWrites: boolean;
  /** Whether `getZone()` can report nameserver delegation. */
  zoneInfo: boolean;
}

export interface DnsProviderContext {
  signal?: AbortSignal;
  logger: DomainLogger;
}

export interface DnsProviderZoneInput {
  /** Normalized zone apex. */
  zone: string;
}

export interface DnsProviderCreateInput extends DnsProviderZoneInput {
  /** Normalized records that are not yet present in the zone. */
  records: DnsRecordInput[];
}

export interface DnsProviderDeleteInput extends DnsProviderZoneInput {
  /** Editable records exactly as `listRecords()` returned them. */
  records: ZoneRecord[];
}

/**
 * Adapter for a DNS host such as a registrar. The DNS client owns diffing, conflict
 * detection, and validation; adapters only translate list, create, and delete calls.
 */
export interface DnsProvider {
  readonly id: string;
  readonly capabilities: DnsProviderCapabilities;
  /** Every record in the zone, with names as lowercase FQDNs. */
  listRecords(input: DnsProviderZoneInput, context: DnsProviderContext): Promise<ZoneRecord[]>;
  createRecords(input: DnsProviderCreateInput, context: DnsProviderContext): Promise<void>;
  deleteRecords(input: DnsProviderDeleteInput, context: DnsProviderContext): Promise<void>;
  getZone?(input: DnsProviderZoneInput, context: DnsProviderContext): Promise<DnsZone>;
}

export type DnsConflictPolicy = "error" | "replace";

export interface EnsureRecordsOptions extends RequestOptions {
  /** Zone apex. Defaults to the registrable domain of the first record. */
  zone?: string;
  /**
   * What to do when an editable record already occupies a name the SDK needs, such as an
   * old A record at the apex or a CNAME where an A record is requested. `error` (default)
   * throws `DOMAIN_CONFLICT`; `replace` deletes the conflicting records first.
   */
  onConflict?: DnsConflictPolicy;
}

export interface RemoveRecordsOptions extends RequestOptions {
  zone?: string;
}

export interface ApplyDomainRecordsOptions extends EnsureRecordsOptions {
  /** Also write optional records. Defaults to required records only. */
  includeOptional?: boolean;
}

export interface DnsClientOptions {
  provider: DnsProvider;
  logger?: DomainLogger;
}

export interface DnsClient {
  readonly provider: string;
  readonly capabilities: DnsProviderCapabilities;
  getZone(zone: string, options?: RequestOptions): Promise<DnsZone>;
  listRecords(zone: string, options?: RequestOptions): Promise<ZoneRecord[]>;
  /** Create any missing records and return the zone records that satisfy the input. */
  ensureRecords(
    records: readonly DnsRecordInput[],
    options?: EnsureRecordsOptions,
  ): Promise<ZoneRecord[]>;
  /** Delete editable records that exactly match the input. Missing records are ignored. */
  removeRecords(records: readonly DnsRecordInput[], options?: RemoveRecordsOptions): Promise<void>;
  /** Write the routing and verification records a hosting provider returned for a domain. */
  applyDomainRecords(domain: Domain, options?: ApplyDomainRecordsOptions): Promise<ZoneRecord[]>;
}

/** Types that may hold only one value per owner name. */
const SINGLETON_TYPES = new Set(["CNAME", "ALIAS", "ANAME"]);
/** Types whose existing values at the same name are replaced rather than added to. */
const ROUTING_TYPES = new Set(["A", "AAAA", "CNAME", "ALIAS", "ANAME"]);
const HOSTNAME_VALUE_TYPES = new Set(["CNAME", "ALIAS", "ANAME", "NS", "MX", "PTR"]);
const RECORD_NAME_LABEL = /^(?:\*|_?[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?|_[a-z0-9_-]{1,62})$/;

function invalidRecord(message: string, details: Record<string, unknown>): never {
  throw new DomainSdkError("INVALID_HOSTNAME", message, { details });
}

/** Normalize a zone apex such as `Example.com.` to `example.com`. */
export function normalizeZone(zone: string): string {
  return normalizeHostname(zone);
}

/**
 * Normalize a record owner name to a lowercase FQDN inside `zone`. Accepts `@` for the apex,
 * underscore labels such as `_vercel`, and a leading `*` label.
 */
export function normalizeRecordName(name: string, zone: string): string {
  const clean = name.trim().toLowerCase().replace(/\.$/, "");
  if (!clean || clean === "@") return zone;
  if (clean !== zone && !clean.endsWith(`.${zone}`))
    invalidRecord(`DNS record ${name} is outside the ${zone} zone.`, { name, zone });
  const labels = clean.split(".");
  labels.forEach((label, index) => {
    if (!RECORD_NAME_LABEL.test(label) || (label === "*" && index !== 0))
      invalidRecord(`DNS record name ${name} is malformed.`, { name, zone });
  });
  if (clean.length > 253) invalidRecord(`DNS record name ${name} is too long.`, { name, zone });
  return clean;
}

/** Convert an FQDN inside `zone` to the zone-relative form, with `@` for the apex. */
export function relativeRecordName(name: string, zone: string): string {
  return name === zone ? "@" : name.slice(0, -(zone.length + 1));
}

/** Convert a zone-relative name (`@`, empty, or `www`) or an FQDN to a lowercase FQDN. */
export function absoluteRecordName(name: string, zone: string): string {
  const clean = name.trim().toLowerCase().replace(/\.$/, "");
  if (!clean || clean === "@" || clean === zone) return zone;
  return clean.endsWith(`.${zone}`) ? clean : `${clean}.${zone}`;
}

/** Split a presentation-format CAA value into its parts. */
export function parseCaaValue(value: string): { flag: number; tag: string; value: string } {
  const match = /^\s*(\d{1,3})\s+([a-z0-9]+)\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))\s*$/i.exec(value);
  const flag = Number(match?.[1]);
  if (!match || flag > 255)
    invalidRecord(`CAA value ${value} must look like 0 issue "letsencrypt.org".`, { value });
  return { flag, tag: match[2]!.toLowerCase(), value: match[3] ?? match[4]! };
}

/** Format CAA parts as a presentation-format value. */
export function formatCaaValue(flag: number, tag: string, value: string): string {
  return `${flag} ${tag.toLowerCase()} "${value}"`;
}

/** Canonical form of a record value for comparison. */
export function canonicalRecordValue(type: string, value: string): string {
  const upper = type.toUpperCase();
  const trimmed = value.trim();
  if (upper === "TXT") return trimmed.replace(/^"(.*)"$/s, "$1");
  if (upper === "CAA") {
    const caa = parseCaaValue(trimmed);
    return formatCaaValue(caa.flag, caa.tag, caa.value);
  }
  if (HOSTNAME_VALUE_TYPES.has(upper)) return trimmed.toLowerCase().replace(/\.$/, "");
  return trimmed.toLowerCase();
}

/** Whether a zone record and an input record describe the same DNS data, ignoring TTL. */
export function sameRecord(
  existing: Pick<ZoneRecord, "type" | "name" | "value">,
  wanted: Pick<DnsRecordInput, "type" | "name" | "value">,
): boolean {
  if (existing.type.toUpperCase() !== wanted.type) return false;
  if (existing.name.toLowerCase() !== wanted.name.toLowerCase()) return false;
  try {
    return (
      canonicalRecordValue(existing.type, existing.value) ===
      canonicalRecordValue(wanted.type, wanted.value)
    );
  } catch {
    return false;
  }
}

function conflictsWith(existing: ZoneRecord, wanted: DnsRecordInput): boolean {
  if (existing.name !== wanted.name || sameRecord(existing, wanted)) return false;
  const type = existing.type.toUpperCase();
  if (type === "CNAME" || wanted.type === "CNAME") return true;
  if (type === wanted.type) return ROUTING_TYPES.has(type);
  return SINGLETON_TYPES.has(type) && SINGLETON_TYPES.has(wanted.type);
}

/** Create a client that writes the records hosting providers return into a DNS host's zone. */
export function createDnsClient(options: DnsClientOptions): DnsClient {
  assertServerEnvironment();
  if (!options?.provider)
    throw new DomainSdkError("INVALID_CONFIGURATION", "A DNS provider is required.");
  const { provider } = options;
  const logger = options.logger ?? {};
  const context = (signal?: AbortSignal): DnsProviderContext => ({ signal, logger });

  const run = async <T>(name: string, zone: string, operation: () => Promise<T>): Promise<T> => {
    logger.debug?.("DNS operation started.", { provider: provider.id, operation: name, zone });
    try {
      const result = await operation();
      logger.info?.("DNS operation completed.", { provider: provider.id, operation: name, zone });
      return result;
    } catch (error) {
      const normalized = normalizeUnknownError(error, provider.id);
      logger.error?.("DNS operation failed.", {
        provider: provider.id,
        operation: name,
        zone,
        code: normalized.code,
        retryable: normalized.retryable,
      });
      throw normalized;
    }
  };

  const resolveZone = (records: readonly DnsRecordInput[], zone: string | undefined): string => {
    if (zone) return normalizeZone(zone);
    const first = records[0]?.name.trim().replace(/^\*\./, "");
    const inferred = first ? getDomain(first, { allowPrivateDomains: false }) : null;
    if (!inferred)
      throw new DomainSdkError(
        "INVALID_CONFIGURATION",
        "Pass options.zone; it could not be inferred from the records.",
        { provider: provider.id },
      );
    return normalizeZone(inferred);
  };

  const normalizeRecords = (records: readonly DnsRecordInput[], zone: string) => {
    const normalized: DnsRecordInput[] = [];
    for (const record of records) {
      const type = record.type.toUpperCase() as DnsRecordType;
      if (!provider.capabilities.recordTypes.includes(type))
        throw new DomainSdkError(
          "UNSUPPORTED_OPERATION",
          `${provider.id} does not support ${type} records.`,
          { provider: provider.id, details: { type } },
        );
      const { min, max } = provider.capabilities.ttl;
      if (
        record.ttl !== undefined &&
        (!Number.isInteger(record.ttl) || record.ttl < min || record.ttl > max)
      )
        throw new DomainSdkError(
          "INVALID_CONFIGURATION",
          `${provider.id} requires a TTL between ${min} and ${max} seconds.`,
          { provider: provider.id, details: { ttl: record.ttl } },
        );
      if (!record.value?.trim())
        throw new DomainSdkError("INVALID_CONFIGURATION", "DNS records require a value.", {
          provider: provider.id,
        });
      const next: DnsRecordInput = {
        type,
        name: normalizeRecordName(record.name, zone),
        value: type === "CAA" ? canonicalRecordValue(type, record.value) : record.value.trim(),
        ttl: record.ttl,
      };
      if (!normalized.some((existing) => sameRecord(existing, next))) normalized.push(next);
    }
    return normalized;
  };

  const ensureRecords: DnsClient["ensureRecords"] = (records, ensure = {}) => {
    const zone = resolveZone(records, ensure.zone);
    return run("ensureRecords", zone, async () => {
      const wanted = normalizeRecords(records, zone);
      if (!wanted.length) return [];
      const ctx = context(ensure.signal);
      const existing = await provider.listRecords({ zone }, ctx);
      const missing = wanted.filter((record) => !existing.some((item) => sameRecord(item, record)));
      const conflicts = existing.filter((item) =>
        missing.some((record) => conflictsWith(item, record)),
      );
      if (conflicts.length) {
        const locked = conflicts.filter((item) => !item.editable);
        if (locked.length || (ensure.onConflict ?? "error") === "error")
          throw new DomainSdkError(
            "DOMAIN_CONFLICT",
            `Existing DNS records in ${zone} conflict with the records being written.`,
            {
              provider: provider.id,
              details: {
                conflicts: conflicts.map(({ type, name, value, editable }) => ({
                  type,
                  name,
                  value,
                  editable,
                })),
              },
            },
          );
        await provider.deleteRecords({ zone, records: conflicts }, ctx);
      }
      if (missing.length) await provider.createRecords({ zone, records: missing }, ctx);
      const after =
        missing.length || conflicts.length ? await provider.listRecords({ zone }, ctx) : existing;
      return after.filter((item) => wanted.some((record) => sameRecord(item, record)));
    });
  };

  return {
    provider: provider.id,
    capabilities: provider.capabilities,
    getZone(zone, request) {
      const normalized = normalizeZone(zone);
      if (!provider.getZone || !provider.capabilities.zoneInfo)
        return Promise.reject(
          new DomainSdkError(
            "UNSUPPORTED_OPERATION",
            `${provider.id} does not report zone delegation.`,
            { provider: provider.id },
          ),
        );
      return run("getZone", normalized, () =>
        provider.getZone!({ zone: normalized }, context(request?.signal)),
      );
    },
    listRecords(zone, request) {
      const normalized = normalizeZone(zone);
      return run("listRecords", normalized, () =>
        provider.listRecords({ zone: normalized }, context(request?.signal)),
      );
    },
    ensureRecords,
    removeRecords(records, remove = {}) {
      const zone = resolveZone(records, remove.zone);
      return run("removeRecords", zone, async () => {
        const wanted = normalizeRecords(records, zone);
        if (!wanted.length) return;
        const ctx = context(remove.signal);
        const existing = await provider.listRecords({ zone }, ctx);
        const matches = existing.filter(
          (item) => item.editable && wanted.some((record) => sameRecord(item, record)),
        );
        if (matches.length) await provider.deleteRecords({ zone, records: matches }, ctx);
      });
    },
    applyDomainRecords(domain, apply = {}) {
      const records = [...domain.records, ...domain.verification.records]
        .filter((record: DnsRecord) => apply.includeOptional || record.required)
        .map(({ type, name, value, ttl }) => ({ type, name, value, ttl }));
      return ensureRecords(records, apply);
    },
  };
}
