import { describe, expect, test } from "bun:test";
import { createDnsClient } from "../src";
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
    ).toBe(true);
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

  test("reports zone delegation", async () => {
    const dns = createDnsClient({ provider: memoryDnsProvider({ authoritative: false }) });
    expect(await dns.getZone("Example.com")).toMatchObject({
      name: "example.com",
      authoritative: false,
    });
  });
});
