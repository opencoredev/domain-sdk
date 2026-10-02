import type {
  DnsProvider,
  DnsProviderCapabilities,
  DnsProviderContext,
  DnsZone,
  ZoneRecord,
} from "../core/dns";
import { abortedError } from "../core/errors";

export interface MemoryDnsProviderOptions {
  /** Records present before the first call, keyed by zone. */
  zones?: Record<string, Omit<ZoneRecord, "id" | "editable">[] | ZoneRecord[]>;
  capabilities?: Partial<DnsProviderCapabilities>;
  /** Defaults to `true` for every zone. */
  authoritative?: boolean;
}

export interface MemoryDnsProvider extends DnsProvider {
  readonly id: "memory-dns";
  /** Current records in a zone. */
  records(zone: string): ZoneRecord[];
  reset(): void;
}

const ALL_TYPES = ["A", "AAAA", "CNAME", "TXT", "CAA", "ALIAS", "ANAME"] as const;

/** In-memory DNS host for tests and local development. */
export function memoryDnsProvider(options: MemoryDnsProviderOptions = {}): MemoryDnsProvider {
  let next = 0;
  let zones = new Map<string, ZoneRecord[]>();
  const seed = () => {
    next = 0;
    zones = new Map(
      Object.entries(options.zones ?? {}).map(([zone, records]) => [
        zone,
        records.map((record) => ({
          editable: true,
          ...record,
          id: (record as ZoneRecord).id ?? `rec_${++next}`,
        })),
      ]),
    );
  };
  seed();
  const zoneRecords = (zone: string) => {
    if (!zones.has(zone)) zones.set(zone, []);
    return zones.get(zone)!;
  };
  const guard = (context: DnsProviderContext) => {
    if (context.signal?.aborted) throw abortedError("memory-dns", context.signal.reason);
  };

  return {
    id: "memory-dns",
    capabilities: {
      recordTypes: ALL_TYPES,
      ttl: { min: 60, max: 86_400 },
      wholeZoneWrites: false,
      zoneInfo: true,
      ...options.capabilities,
    },
    records: (zone) => zoneRecords(zone).map((record) => ({ ...record })),
    reset: seed,
    async listRecords({ zone }, context) {
      guard(context);
      return zoneRecords(zone).map((record) => ({ ...record }));
    },
    async createRecords({ zone, records }, context) {
      guard(context);
      zoneRecords(zone).push(
        ...records.map((record) => ({
          id: `rec_${++next}`,
          type: record.type,
          name: record.name,
          value: record.value,
          ttl: record.ttl ?? 300,
          editable: true,
        })),
      );
    },
    async deleteRecords({ zone, records }, context) {
      guard(context);
      const ids = new Set(records.map((record) => record.id));
      zones.set(
        zone,
        zoneRecords(zone).filter((record) => !ids.has(record.id)),
      );
    },
    async getZone({ zone }, context): Promise<DnsZone> {
      guard(context);
      return {
        name: zone,
        provider: "memory-dns",
        authoritative: options.authoritative ?? true,
        nameservers: ["ns1.memory.test", "ns2.memory.test"],
      };
    },
  };
}
