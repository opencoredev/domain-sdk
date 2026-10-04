import { describe, expect, test } from "bun:test";
import { createDnsClient, DomainSdkError } from "../src";
import { canonicalRecordValue, normalizeRecordName, sameRecord } from "../src/core/dns";
import { createMockDomain, memoryDnsProvider } from "../src/testing";
import { dnsProviderContract } from "./contract/dns-contract";

dnsProviderContract("memory", () => memoryDnsProvider());

describe("DNS record helpers", () => {
  test("normalizes names inside the zone", () => {
    expect(normalizeRecordName("@", "example.com")).toBe("example.com");
    expect(normalizeRecordName("_Vercel.Example.com.", "example.com")).toBe("_vercel.example.com");
    expect(normalizeRecordName("*.example.com", "example.com")).toBe("*.example.com");
    expect(() => normalizeRecordName("app.other.com", "example.com")).toThrow();
    expect(() => normalizeRecordName("a.*.example.com", "example.com")).toThrow();
  });

  test("compares values canonically", () => {
    expect(canonicalRecordValue("CNAME", "Cname.Vercel-DNS.com.")).toBe("cname.vercel-dns.com");
    expect(canonicalRecordValue("CAA", '0 ISSUE "letsencrypt.org"')).toBe(
      '0 issue "letsencrypt.org"',
    );
    expect(
      sameRecord(
        { type: "txt", name: "a.example.com", value: '"Token"' },
        { type: "TXT", name: "a.example.com", value: "Token" },
      ),
    ).toBe(false);
    expect(
      sameRecord(
        { type: "TXT", name: "a.example.com", value: "token" },
        { type: "TXT", name: "a.example.com", value: "Token" },
      ),
    ).toBe(false);
  });
});

describe("createDnsClient", () => {
  test("rejects unsupported types and out-of-range TTLs", async () => {
    const dns = createDnsClient({
      provider: memoryDnsProvider({
        capabilities: { recordTypes: ["A", "TXT"], ttl: { min: 600, max: 3600 } },
      }),
    });
    await expect(
      dns.ensureRecords([{ type: "ANAME", name: "example.com", value: "x.example.net" }]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      dns.ensureRecords([{ type: "A", name: "example.com", value: "192.0.2.1", ttl: 60 }]),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  test("infers multi-label public suffix zones", async () => {
    const provider = memoryDnsProvider();
    const dns = createDnsClient({ provider });
    await dns.ensureRecords([{ type: "A", name: "www.example.co.uk", value: "192.0.2.1" }]);
    expect(provider.records("example.co.uk")).toHaveLength(1);
  });

  test("never deletes records the host manages", async () => {
    const dns = createDnsClient({
      provider: memoryDnsProvider({
        zones: {
          "example.com": [{ type: "A", name: "example.com", value: "192.0.2.1", editable: false }],
        },
      }),
    });
    await expect(
      dns.ensureRecords([{ type: "A", name: "example.com", value: "76.76.21.21" }], {
        onConflict: "replace",
      }),
    ).rejects.toMatchObject({ code: "DOMAIN_CONFLICT" });
    await dns.removeRecords([{ type: "A", name: "example.com", value: "192.0.2.1" }]);
    expect(await dns.listRecords("example.com")).toHaveLength(1);
  });

  test("applies the required records of a hosting domain", async () => {
    const provider = memoryDnsProvider();
    const dns = createDnsClient({ provider });
    const domain = createMockDomain({ hostname: "app.example.com" });
    const written = await dns.applyDomainRecords(domain);
    const required = [...domain.records, ...domain.verification.records].filter((r) => r.required);
    expect(written).toHaveLength(required.length);
  });

  test("replace keeps existing records that are part of the request", async () => {
    const provider = memoryDnsProvider({
      zones: { "example.com": [{ type: "A", name: "example.com", value: "192.0.2.1" }] },
    });
    const dns = createDnsClient({ provider });
    const written = await dns.ensureRecords(
      [
        { type: "A", name: "example.com", value: "192.0.2.1" },
        { type: "A", name: "example.com", value: "192.0.2.2" },
      ],
      { onConflict: "replace" },
    );
    expect(written.map((record) => record.value).sort()).toEqual(["192.0.2.1", "192.0.2.2"]);
    expect(provider.records("example.com")).toHaveLength(2);
  });

  test("rejects a self-contradicting request before touching the zone", async () => {
    const provider = memoryDnsProvider({
      zones: { "example.com": [{ type: "A", name: "app.example.com", value: "192.0.2.1" }] },
    });
    const dns = createDnsClient({ provider });
    await expect(
      dns.ensureRecords(
        [
          { type: "CNAME", name: "app.example.com", value: "cname.vercel-dns.com" },
          { type: "TXT", name: "app.example.com", value: "token" },
        ],
        { onConflict: "replace" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(provider.records("example.com")).toHaveLength(1);
  });

  test("keeps TXT quotes and spacing as data", async () => {
    const provider = memoryDnsProvider({
      zones: { "example.com": [{ type: "TXT", name: "example.com", value: '"token"' }] },
    });
    const dns = createDnsClient({ provider });
    await dns.removeRecords([{ type: "TXT", name: "example.com", value: "token" }]);
    expect(provider.records("example.com")).toHaveLength(1);
  });

  test("reports a stale address beside a requested one", async () => {
    const provider = memoryDnsProvider({
      zones: {
        "example.com": [
          { type: "A", name: "example.com", value: "76.76.21.21" },
          { type: "A", name: "example.com", value: "192.0.2.1" },
        ],
      },
    });
    const dns = createDnsClient({ provider });
    const wanted = [{ type: "A" as const, name: "example.com", value: "76.76.21.21" }];
    await expect(dns.ensureRecords(wanted)).rejects.toMatchObject({ code: "DOMAIN_CONFLICT" });
    await dns.ensureRecords(wanted, { onConflict: "replace" });
    expect(provider.records("example.com").map((record) => record.value)).toEqual(["76.76.21.21"]);
  });

  test("treats ALIAS and A records at one name as conflicting", async () => {
    const provider = memoryDnsProvider({
      zones: { "example.com": [{ type: "A", name: "example.com", value: "192.0.2.1" }] },
    });
    const dns = createDnsClient({ provider });
    const alias = { type: "ALIAS" as const, name: "example.com", value: "cname.vercel-dns.com" };
    await expect(dns.ensureRecords([alias])).rejects.toMatchObject({ code: "DOMAIN_CONFLICT" });
    await expect(
      dns.ensureRecords([alias, { type: "A", name: "example.com", value: "192.0.2.1" }]),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await dns.ensureRecords([alias], { onConflict: "replace" });
    expect(provider.records("example.com").map((record) => record.type)).toEqual(["ALIAS"]);
  });

  test("restores replaced records when the replacement fails", async () => {
    const provider = memoryDnsProvider({
      zones: { "example.com": [{ type: "A", name: "example.com", value: "192.0.2.1" }] },
    });
    const create = provider.createRecords;
    let calls = 0;
    provider.createRecords = (input, context) => {
      if (calls++ === 0)
        return Promise.reject(
          new DomainSdkError("RATE_LIMITED", "Slow down.", { retryable: true }),
        );
      return create(input, context);
    };
    const dns = createDnsClient({ provider });
    const error = await dns
      .ensureRecords([{ type: "A", name: "example.com", value: "76.76.21.21" }], {
        onConflict: "replace",
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      details: { restored: true },
    });
    expect(provider.records("example.com").map((record) => record.value)).toEqual(["192.0.2.1"]);
  });

  test("removes record types the provider cannot create", async () => {
    const provider = memoryDnsProvider({
      capabilities: { recordTypes: ["A"], ttl: { min: 60, max: 3600 } },
      zones: { "example.com": [{ type: "ANAME", name: "example.com", value: "x.example.net" }] },
    });
    const dns = createDnsClient({ provider });
    await dns.removeRecords([{ type: "ANAME", name: "example.com", value: "x.example.net" }]);
    expect(provider.records("example.com")).toHaveLength(0);
  });

  test("handles empty record sets", async () => {
    const dns = createDnsClient({ provider: memoryDnsProvider() });
    expect(await dns.ensureRecords([])).toEqual([]);
    await dns.removeRecords([]);
    const domain = createMockDomain({ hostname: "app.example.com" });
    domain.records = [];
    domain.verification.records = [];
    expect(await dns.applyDomainRecords(domain)).toEqual([]);
  });

  test("skips optional records that contradict the chosen ones", async () => {
    const provider = memoryDnsProvider();
    const dns = createDnsClient({ provider });
    const domain = createMockDomain({ hostname: "app.example.com" });
    const record = (value: string, required: boolean) => ({
      type: "CNAME" as const,
      name: "app.example.com",
      value,
      required,
      purpose: "routing" as const,
      status: "pending" as const,
    });
    domain.records = [record("cname.vercel-dns.com", true), record("alt.vercel-dns.com", false)];
    domain.verification.records = [];
    await dns.applyDomainRecords(domain, { includeOptional: true });
    expect(provider.records("example.com").map((item) => item.value)).toEqual([
      "cname.vercel-dns.com",
    ]);
  });

  test("accepts internationalized record names", async () => {
    expect(normalizeRecordName("_verify.Bücher.de", "xn--bcher-kva.de")).toBe(
      "_verify.xn--bcher-kva.de",
    );
    const provider = memoryDnsProvider();
    const dns = createDnsClient({ provider });
    await dns.ensureRecords([{ type: "TXT", name: "_verify.bücher.de", value: "token" }], {
      zone: "bücher.de",
    });
    expect(provider.records("xn--bcher-kva.de")[0]?.name).toBe("_verify.xn--bcher-kva.de");
  });

  test("memory provider never reuses a seeded id", async () => {
    const provider = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "rec_1", type: "A", name: "example.com", value: "192.0.2.1", editable: true },
        ],
      },
    });
    const dns = createDnsClient({ provider });
    await dns.ensureRecords([{ type: "TXT", name: "example.com", value: "token" }]);
    const ids = provider.records("example.com").map((record) => record.id);
    expect(new Set(ids).size).toBe(2);
  });

  test("reports zone delegation", async () => {
    const dns = createDnsClient({ provider: memoryDnsProvider({ authoritative: false }) });
    expect(await dns.getZone("Example.com")).toMatchObject({
      name: "example.com",
      authoritative: false,
    });
  });
});
