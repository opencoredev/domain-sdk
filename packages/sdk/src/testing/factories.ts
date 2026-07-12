import type { DnsRecord, Domain } from "../core/types";

export function createMockDnsRecord(overrides: Partial<DnsRecord> = {}): DnsRecord {
  return {
    type: "CNAME",
    name: "app.customer.com",
    value: "target.example.net",
    purpose: "routing",
    required: true,
    status: "pending",
    ...overrides,
  };
}

export function createMockDomain(overrides: Partial<Domain> = {}): Domain {
  const hostname = overrides.hostname ?? "app.customer.com";
  const records = overrides.records ?? [createMockDnsRecord({ name: hostname })];
  return {
    id: `memory:${hostname}`,
    hostname,
    provider: "memory",
    status: "pending_dns",
    records,
    verification: {
      status: "pending",
      records: records.filter((record) => record.purpose === "ownership"),
    },
    certificate: { status: "pending" },
    issues: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
