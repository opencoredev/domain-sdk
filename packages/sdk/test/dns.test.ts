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

  test("rolls back partial deletes and creates", async () => {
    const seeded = [
      { type: "A" as const, name: "example.com", value: "192.0.2.1" },
      { type: "A" as const, name: "example.com", value: "192.0.2.2" },
    ];
    const provider = memoryDnsProvider({ zones: { "example.com": seeded } });
    const { createRecords, deleteRecords } = provider;
    let failDelete = true;
    provider.deleteRecords = async (input, context) => {
      if (failDelete) {
        failDelete = false;
        await deleteRecords({ ...input, records: input.records.slice(0, 1) }, context);
        throw new DomainSdkError("PROVIDER_UNAVAILABLE", "Down.", { retryable: true });
      }
      return deleteRecords(input, context);
    };
    const dns = createDnsClient({ provider });
    const wanted = [
      { type: "A" as const, name: "example.com", value: "76.76.21.21" },
      { type: "A" as const, name: "example.com", value: "76.76.21.22" },
    ];
    await expect(dns.ensureRecords(wanted, { onConflict: "replace" })).rejects.toMatchObject({
      details: { restored: true },
    });
    const values = () =>
      provider
        .records("example.com")
        .map((record) => record.value)
        .sort();
    expect(values()).toEqual(["192.0.2.1", "192.0.2.2"]);

    let failCreate = true;
    provider.createRecords = async (input, context) => {
      if (failCreate) {
        failCreate = false;
        await createRecords({ ...input, records: input.records.slice(0, 1) }, context);
        throw new DomainSdkError("RATE_LIMITED", "Slow down.", { retryable: true });
      }
      return createRecords(input, context);
    };
    await expect(dns.ensureRecords(wanted, { onConflict: "replace" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { restored: true },
    });
    expect(values()).toEqual(["192.0.2.1", "192.0.2.2"]);
  });

  test("rollback restores a deleted copy of an identical record", async () => {
    const seeded = [
      { type: "TXT" as const, name: "example.com", value: "same", ttl: 300 },
      { type: "TXT" as const, name: "example.com", value: "same", ttl: 60 },
      { type: "CNAME" as const, name: "www.example.com", value: "old.example.net" },
    ];
    const provider = memoryDnsProvider({ zones: { "example.com": seeded } });
    const { deleteRecords } = provider;
    let fail = true;
    provider.deleteRecords = async (input, context) => {
      if (fail) {
        fail = false;
        const copy = input.records.find((record) => record.ttl === 300)!;
        await deleteRecords({ ...input, records: [copy] }, context);
        throw new DomainSdkError("PROVIDER_UNAVAILABLE", "Down.", { retryable: true });
      }
      return deleteRecords(input, context);
    };
    const dns = createDnsClient({ provider });
    await expect(
      dns.ensureRecords([{ type: "CNAME", name: "example.com", value: "cname.vercel-dns.com" }], {
        onConflict: "replace",
      }),
    ).rejects.toMatchObject({ details: { restored: true } });
    expect(
      provider
        .records("example.com")
        .filter((record) => record.type === "TXT")
        .map((record) => record.ttl)
        .sort(),
    ).toEqual([300, 60]);
  });

  test("a failed delete never removes requested records written by someone else", async () => {
    const provider = memoryDnsProvider({
      zones: { "example.com": [{ type: "A", name: "example.com", value: "192.0.2.1" }] },
    });
    const { createRecords } = provider;
    provider.deleteRecords = async (input, context) => {
      await createRecords(
        { zone: input.zone, records: [{ type: "A", name: "example.com", value: "76.76.21.21" }] },
        context,
      );
      throw new DomainSdkError("PROVIDER_UNAVAILABLE", "Down.", { retryable: true });
    };
    const dns = createDnsClient({ provider });
    await expect(
      dns.ensureRecords([{ type: "A", name: "example.com", value: "76.76.21.21" }], {
        onConflict: "replace",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(
      provider
        .records("example.com")
        .map((record) => record.value)
        .sort(),
    ).toEqual(["192.0.2.1", "76.76.21.21"]);
  });

  test("prefers an optional route that is already in the zone", async () => {
    const provider = memoryDnsProvider({
      zones: { "example.com": [{ type: "A", name: "app.example.com", value: "76.76.21.21" }] },
    });
    const dns = createDnsClient({ provider });
    const domain = createMockDomain({ hostname: "app.example.com" });
    const optional = { required: false, purpose: "routing" as const, status: "pending" as const };
    domain.records = [
      { type: "CNAME", name: "app.example.com", value: "cname.vercel-dns.com", ...optional },
      { type: "A", name: "app.example.com", value: "76.76.21.21", ...optional },
    ];
    domain.verification.records = [];
    const written = await dns.applyDomainRecords(domain, { includeOptional: true });
    expect(written.map((record) => record.type)).toEqual(["A"]);
    expect(provider.records("example.com")).toHaveLength(1);
  });

  test("never replaces a record the provider cannot restore", async () => {
    const provider = memoryDnsProvider({
      capabilities: { recordTypes: ["CNAME"], ttl: { min: 60, max: 3600 } },
      zones: {
        "example.com": [{ type: "MX", name: "app.example.com", value: "mail.example.net" }],
      },
    });
    const dns = createDnsClient({ provider });
    await expect(
      dns.ensureRecords(
        [{ type: "CNAME", name: "app.example.com", value: "cname.vercel-dns.com" }],
        {
          onConflict: "replace",
        },
      ),
    ).rejects.toMatchObject({ code: "DOMAIN_CONFLICT" });
    expect(provider.records("example.com").map((record) => record.type)).toEqual(["MX"]);
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

  test("serializes concurrent writes to one zone", async () => {
    const provider = memoryDnsProvider();
    const dns = createDnsClient({ provider });
    const results = await Promise.allSettled([
      dns.ensureRecords([{ type: "A", name: "example.com", value: "192.0.2.1" }]),
      dns.ensureRecords([{ type: "A", name: "example.com", value: "192.0.2.2" }]),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(provider.records("example.com")).toHaveLength(1);
  });

  test("reports zone delegation", async () => {
    const dns = createDnsClient({ provider: memoryDnsProvider({ authoritative: false }) });
    expect(await dns.getZone("Example.com")).toMatchObject({
      name: "example.com",
      authoritative: false,
    });
  });
});

describe("ensureRecords write verification", () => {
  test("fails when the DNS host silently drops a created record", async () => {
    const provider = memoryDnsProvider();
    const { createRecords } = provider;
    // Accept the request but only keep the first record, as a lossy host might.
    provider.createRecords = (input, context) =>
      createRecords({ ...input, records: input.records.slice(0, 1) }, context);
    const dns = createDnsClient({ provider });
    const error = await dns
      .ensureRecords([
        { type: "A", name: "app.example.com", value: "192.0.2.1" },
        { type: "TXT", name: "_verify.example.com", value: "token" },
      ])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainSdkError);
    expect(error).toMatchObject({
      code: "REQUEST_FAILED",
      retryable: false,
      details: { missing: [{ type: "TXT", name: "_verify.example.com", value: "token" }] },
    });
  });

  test("fails when the DNS host rewrites a value after accepting it", async () => {
    const provider = memoryDnsProvider();
    const { createRecords } = provider;
    provider.createRecords = (input, context) =>
      createRecords(
        { ...input, records: input.records.map((record) => ({ ...record, value: "192.0.2.99" })) },
        context,
      );
    const dns = createDnsClient({ provider });
    await expect(
      dns.ensureRecords([{ type: "A", name: "app.example.com", value: "192.0.2.1" }]),
    ).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      details: { missing: [{ type: "A", name: "app.example.com", value: "192.0.2.1" }] },
    });
  });

  test("rolls back replaced conflicts when a replacement write is silently dropped", async () => {
    const provider = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "old", type: "A", name: "app.example.com", value: "192.0.2.10", editable: true },
        ],
      },
    });
    const { createRecords } = provider;
    let dropFirst = true;
    provider.createRecords = (input, context) => {
      if (dropFirst) {
        dropFirst = false;
        return Promise.resolve();
      }
      return createRecords(input, context);
    };
    const dns = createDnsClient({ provider });
    const error = await dns
      .ensureRecords([{ type: "A", name: "app.example.com", value: "192.0.2.20" }], {
        onConflict: "replace",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainSdkError);
    expect(error).toMatchObject({
      code: "REQUEST_FAILED",
      details: {
        restored: true,
        missing: [{ type: "A", name: "app.example.com", value: "192.0.2.20" }],
        replaced: [{ type: "A", name: "app.example.com", value: "192.0.2.10" }],
      },
    });
    expect(provider.records("example.com").map((record) => record.value)).toEqual(["192.0.2.10"]);
  });

  test("fails and rolls back newly created records when conflict deletion was ignored", async () => {
    const provider = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "old", type: "A", name: "app.example.com", value: "192.0.2.10", editable: true },
        ],
      },
    });
    const { deleteRecords } = provider;
    let ignoreFirstDelete = true;
    provider.deleteRecords = (input, context) => {
      if (ignoreFirstDelete) {
        ignoreFirstDelete = false;
        return Promise.resolve();
      }
      return deleteRecords(input, context);
    };
    const dns = createDnsClient({ provider });
    const error = await dns
      .ensureRecords([{ type: "A", name: "app.example.com", value: "192.0.2.20" }], {
        onConflict: "replace",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainSdkError);
    expect(error).toMatchObject({
      code: "REQUEST_FAILED",
      details: {
        restored: true,
        remaining: [{ type: "A", name: "app.example.com", value: "192.0.2.10" }],
      },
    });
    expect(provider.records("example.com").map((record) => record.value)).toEqual(["192.0.2.10"]);
  });

  test("reports restored: false when recovery createRecords also silently drops writes", async () => {
    const provider = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "old", type: "A", name: "app.example.com", value: "192.0.2.10", editable: true },
        ],
      },
    });
    provider.createRecords = () => Promise.resolve();
    const dns = createDnsClient({ provider });
    const error = await dns
      .ensureRecords([{ type: "A", name: "app.example.com", value: "192.0.2.20" }], {
        onConflict: "replace",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainSdkError);
    expect(error).toMatchObject({
      code: "REQUEST_FAILED",
      details: { restored: false },
    });
    expect(provider.records("example.com")).toEqual([]);
  });

  test("detects conflicting records that appear during post-write read even without initial conflicts", async () => {
    const provider = memoryDnsProvider();
    const { createRecords } = provider;
    provider.createRecords = async (input, ctx) => {
      await createRecords(input, ctx);
      await createRecords(
        {
          zone: input.zone,
          records: [{ type: "A", name: "app.example.com", value: "192.0.2.99" }],
        },
        ctx,
      );
    };
    const dns = createDnsClient({ provider });
    await expect(
      dns.ensureRecords([{ type: "A", name: "app.example.com", value: "192.0.2.20" }]),
    ).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      details: { remaining: [{ type: "A", name: "app.example.com", value: "192.0.2.99" }] },
    });
  });

  test("rolls back replacement when post-write verification read fails", async () => {
    const provider = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "old", type: "A", name: "app.example.com", value: "192.0.2.10", editable: true },
        ],
      },
    });
    const { listRecords } = provider;
    let reads = 0;
    provider.listRecords = (input, ctx) => {
      reads += 1;
      if (reads === 2)
        return Promise.reject(new DomainSdkError("REQUEST_FAILED", "verification read failed"));
      return listRecords(input, ctx);
    };
    const dns = createDnsClient({ provider });
    const error = await dns
      .ensureRecords([{ type: "A", name: "app.example.com", value: "192.0.2.20" }], {
        onConflict: "replace",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainSdkError);
    expect(error).toMatchObject({
      code: "REQUEST_FAILED",
      details: { restored: true },
    });
    expect(provider.records("example.com").map((record) => record.value)).toEqual(["192.0.2.10"]);
  });

  test("rollback cleans up provider-rewritten values and reports restored false if any pre-write editable record disappears", async () => {
    // 1. Provider rewrites replacement value to 192.0.2.99; rollback removes it and restores 192.0.2.10.
    const provider = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "old", type: "A", name: "app.example.com", value: "192.0.2.10", editable: true },
        ],
      },
    });
    const baseCreate = provider.createRecords.bind(provider);
    let createCalls = 0;
    provider.createRecords = (input, ctx) =>
      baseCreate(
        {
          ...input,
          records:
            ++createCalls === 1
              ? input.records.map((record) => ({ ...record, value: "192.0.2.99" }))
              : input.records,
        },
        ctx,
      );
    const dns = createDnsClient({ provider });
    const rewrittenErr = await dns
      .ensureRecords([{ type: "A", name: "app.example.com", value: "192.0.2.20" }], {
        onConflict: "replace",
      })
      .catch((caught: unknown) => caught);
    expect(rewrittenErr).toMatchObject({ code: "REQUEST_FAILED", details: { restored: true } });
    expect(provider.records("example.com").map((record) => record.value)).toEqual(["192.0.2.10"]);

    // 2. Provider drops an unrelated pre-existing editable TXT record and refuses to recreate it.
    const lossy = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "old-a", type: "A", name: "example.com", value: "1.1.1.1", editable: true },
          { id: "old-txt", type: "TXT", name: "_v.example.com", value: "tok", editable: true },
        ],
      },
    });
    const lossyCreate = lossy.createRecords.bind(lossy);
    const lossyDelete = lossy.deleteRecords.bind(lossy);
    lossy.createRecords = async (input, ctx) => {
      // Drop pre-existing TXT during the replacement write and ignore TXT recreations during rollback.
      const existingTxt = lossy.records("example.com").filter((r) => r.type === "TXT");
      if (existingTxt.length) await lossyDelete({ zone: input.zone, records: existingTxt }, ctx);
      const nonTxt = input.records.filter((r) => r.type !== "TXT");
      if (nonTxt.length) await lossyCreate({ zone: input.zone, records: nonTxt }, ctx);
    };
    const lossyDns = createDnsClient({ provider: lossy });
    const droppedErr = await lossyDns
      .ensureRecords(
        [
          { type: "A", name: "example.com", value: "2.2.2.2" },
          { type: "TXT", name: "_v.example.com", value: "tok" },
        ],
        { onConflict: "replace" },
      )
      .catch((caught: unknown) => caught);
    expect(droppedErr).toMatchObject({ code: "REQUEST_FAILED", details: { restored: false } });
  });

  test("handles lowercase ZoneRecord.type during conflict replacement", async () => {
    const provider = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "lower", type: "a", name: "app.example.com", value: "192.0.2.1", editable: true },
        ],
      },
    });
    const dns = createDnsClient({ provider });
    const records = await dns.ensureRecords(
      [{ type: "A", name: "app.example.com", value: "192.0.2.2" }],
      { onConflict: "replace" },
    );
    expect(records.map((r) => r.value)).toEqual(["192.0.2.2"]);
  });
});
