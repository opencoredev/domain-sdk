import { describe, expect, test } from "bun:test";
import { createDnsClient } from "../../src";
import type { DnsProviderContext, DnsRecordInput } from "../../src/core/dns";
import { spaceship } from "../../src/providers/spaceship";
import { dnsProviderContract } from "../contract/dns-contract";
import { json, mockFetch } from "../helpers/fetch";

interface ApiRecord {
  type: string;
  name: string;
  ttl: number;
  group?: { type: string };
  [field: string]: unknown;
}

const context: DnsProviderContext = { logger: {} };
const credentials = { apiKey: "test-key", apiSecret: "test-secret" };

function fakeApi(initial: ApiRecord[] = [], delegation = "basic") {
  let records = [...initial];
  const mock = mockFetch((url, init) => {
    expect(new Headers(init?.headers).get("X-API-Key")).toBe(credentials.apiKey);
    expect(new Headers(init?.headers).get("X-API-Secret")).toBe(credentials.apiSecret);
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    if (url.pathname === "/api/v1/domains/example.com")
      return json({ nameservers: { provider: delegation, hosts: ["NS1.Spaceship.com."] } });
    expect(url.pathname).toBe("/api/v1/dns/records/example.com");
    if (!init?.method || init.method === "GET") {
      expect(url.searchParams.get("take")).toBe("100");
      const skip = Number(url.searchParams.get("skip"));
      return json({ items: records.slice(skip, skip + 100), total: records.length });
    }
    const body = JSON.parse(String(init.body));
    if (init.method === "PUT") {
      expect(body.force).toBe(false);
      for (const item of body.items as ApiRecord[]) {
        if (!records.some((existing) => identity(existing) === identity(item)))
          records.push({ ...item, group: { type: "custom" } });
      }
    } else {
      expect(init.method).toBe("DELETE");
      expect(Array.isArray(body)).toBe(true);
      const removed = body.map(identity);
      records = records.filter((record) => !removed.includes(identity(record)));
    }
    return new Response(null, { status: 204 });
  });
  return { ...mock, provider: spaceship({ ...credentials, fetch: mock.fetch }) };
}

function identity(record: Record<string, unknown>) {
  return JSON.stringify(
    Object.entries(record)
      .filter(([field]) => field !== "ttl" && field !== "group")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

dnsProviderContract("spaceship", () => fakeApi().provider);

describe("spaceship DNS", () => {
  test("translates each supported type and preserves unrelated records", async () => {
    const fake = fakeApi([
      { type: "TXT", name: "existing", value: "keep", ttl: 300, group: { type: "custom" } },
    ]);
    const controller = new AbortController();
    const records: DnsRecordInput[] = [
      { type: "A", name: "example.com", value: "192.0.2.1" },
      { type: "AAAA", name: "*.example.com", value: "2001:db8::1", ttl: 60 },
      { type: "CNAME", name: "www.example.com", value: "target.example.net." },
      { type: "ALIAS", name: "alias.example.com", value: "alias.example.net" },
      { type: "TXT", name: "_verify.example.com", value: 'a "quoted" token' },
      { type: "CAA", name: "example.com", value: '0 issue "letsencrypt.org"' },
    ];
    await fake.provider.createRecords(
      { zone: "example.com", records },
      { ...context, signal: controller.signal },
    );
    expect(fake.calls[0]?.url).toBe("https://spaceship.dev/api/v1/dns/records/example.com");
    expect(fake.calls[0]?.init?.method).toBe("PUT");
    expect(fake.calls[0]?.init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({
      force: false,
      items: [
        { type: "A", name: "@", address: "192.0.2.1", ttl: 3600 },
        { type: "AAAA", name: "*", address: "2001:db8::1", ttl: 60 },
        { type: "CNAME", name: "www", cname: "target.example.net.", ttl: 3600 },
        { type: "ALIAS", name: "alias", aliasName: "alias.example.net", ttl: 3600 },
        { type: "TXT", name: "_verify", value: 'a "quoted" token', ttl: 3600 },
        { type: "CAA", name: "@", flag: 0, tag: "issue", value: "letsencrypt.org", ttl: 3600 },
      ],
    });
    const listed = await fake.provider.listRecords({ zone: "example.com" }, context);
    expect(listed).toHaveLength(7);
    expect(
      listed.slice(1).map(({ type, name, value, ttl, editable, id }) => ({
        type,
        name,
        value,
        ttl,
        editable,
        id,
      })),
    ).toEqual(
      records.map((record) => ({
        ...record,
        ttl: record.ttl ?? 3600,
        editable: true,
        id: undefined,
      })),
    );
    await fake.provider.deleteRecords({ zone: "example.com", records: listed.slice(1) }, context);
    const deletion = JSON.parse(String(fake.calls.at(-1)?.init?.body));
    expect(deletion).toEqual(
      JSON.parse(String(fake.calls[0]?.init?.body)).items.map(
        ({ ttl: _ttl, ...item }: ApiRecord) => item,
      ),
    );
    expect(await fake.provider.listRecords({ zone: "example.com" }, context)).toMatchObject([
      { value: "keep" },
    ]);
  });

  test("paginates, normalizes names, and identifies managed records", async () => {
    const initial = Array.from({ length: 205 }, (_, index) => ({
      type: "TXT",
      name: `Record${index}`,
      value: `token${index}`,
      ttl: 300,
      group: { type: "custom" },
    }));
    const fake = fakeApi([
      ...initial,
      {
        type: "MX",
        name: "@",
        exchange: "mail.example.net.",
        preference: 10,
        ttl: 3600,
        group: { type: "product" },
      },
      {
        type: "NS",
        name: "Child",
        nameserver: "ns.example.net.",
        ttl: 3600,
        group: { type: "personalNs" },
      },
      {
        type: "SRV",
        name: "@",
        service: "_service",
        protocol: "_tcp",
        target: "service.example.net.",
        port: 443,
        priority: 1,
        weight: 10,
        ttl: 600,
        group: { type: "custom" },
      },
    ]);
    const records = await fake.provider.listRecords({ zone: "example.com" }, context);
    expect(records).toHaveLength(208);
    expect(fake.calls.map(({ url }) => url)).toEqual(
      [0, 100, 200].map(
        (skip) => `https://spaceship.dev/api/v1/dns/records/example.com?take=100&skip=${skip}`,
      ),
    );
    expect(records[0]).toMatchObject({ name: "record0.example.com", editable: true, ttl: 300 });
    expect(records[205]).toMatchObject({
      type: "MX",
      name: "example.com",
      value: "mail.example.net.",
      priority: 10,
      editable: false,
    });
    expect(records[206]).toMatchObject({
      type: "NS",
      name: "child.example.com",
      value: "ns.example.net.",
      editable: false,
    });
    await fake.provider.deleteRecords(
      { zone: "example.com", records: records.slice(205) },
      context,
    );
    expect(JSON.parse(String(fake.calls.at(-1)?.init?.body))).toEqual([
      {
        type: "SRV",
        name: "@",
        service: "_service",
        protocol: "_tcp",
        target: "service.example.net.",
        port: 443,
        priority: 1,
        weight: 10,
      },
    ]);
  });

  test("protects managed records through the DNS client", async () => {
    const fake = fakeApi([
      { type: "A", name: "@", address: "192.0.2.1", ttl: 3600, group: { type: "product" } },
    ]);
    const dns = createDnsClient({ provider: fake.provider });
    await expect(
      dns.ensureRecords([{ type: "A", name: "example.com", value: "192.0.2.2" }], {
        onConflict: "replace",
      }),
    ).rejects.toMatchObject({ code: "DOMAIN_CONFLICT" });
    await dns.removeRecords([{ type: "A", name: "example.com", value: "192.0.2.1" }]);
    expect(fake.calls.every(({ init }) => !init?.method)).toBe(true);
  });

  test("reconstructs compound owners and preserves them during apex replacement", async () => {
    const compound: ApiRecord[] = [
      {
        type: "SRV",
        name: "@",
        service: "_SIP",
        protocol: "_TCP",
        priority: 1,
        weight: 10,
        port: 5060,
        target: "sip.example.net",
        ttl: 600,
        group: { type: "custom" },
      },
      {
        type: "TLSA",
        name: "@",
        port: "_443",
        protocol: "_tcp",
        usage: 2,
        selector: 1,
        matching: 1,
        associationData: "ab".repeat(32),
        ttl: 600,
        group: { type: "custom" },
      },
      {
        type: "HTTPS",
        name: "@",
        port: "_8443",
        scheme: "_https",
        svcPriority: 1,
        targetName: ".",
        svcParams: "",
        ttl: 600,
        group: { type: "custom" },
      },
      {
        type: "SVCB",
        name: "@",
        port: "*",
        scheme: "_tcp",
        svcPriority: 1,
        targetName: ".",
        svcParams: "",
        ttl: 600,
        group: { type: "custom" },
      },
    ];
    const fake = fakeApi([
      ...compound,
      { type: "A", name: "@", address: "192.0.2.1", ttl: 600, group: { type: "custom" } },
    ]);
    const dns = createDnsClient({ provider: fake.provider });
    expect((await dns.listRecords("example.com")).slice(0, 4).map((record) => record.name)).toEqual(
      [
        "_sip._tcp.example.com",
        "_443._tcp.example.com",
        "_8443._https.example.com",
        "*._tcp.example.com",
      ],
    );
    await dns.ensureRecords([{ type: "CNAME", name: "example.com", value: "target.example.net" }], {
      onConflict: "replace",
    });
    const deletion = fake.calls.find(({ init }) => init?.method === "DELETE");
    expect(JSON.parse(String(deletion?.init?.body))).toEqual([
      { type: "A", name: "@", address: "192.0.2.1" },
    ]);
    expect(await dns.listRecords("example.com")).toHaveLength(5);
  });

  test.each(["basic", "custom"])("reports %s nameserver delegation", async (delegation) => {
    const fake = fakeApi([], delegation);
    expect(await fake.provider.getZone!({ zone: "example.com" }, context)).toEqual({
      name: "example.com",
      provider: "spaceship",
      authoritative: delegation === "basic",
      nameservers: ["ns1.spaceship.com"],
    });
    expect(fake.calls[0]?.url).toBe("https://spaceship.dev/api/v1/domains/example.com");
  });

  test("treats every API name as relative to the zone", async () => {
    const fake = fakeApi([
      { type: "TXT", name: "example.com", value: "child", ttl: 300, group: { type: "custom" } },
      { type: "TXT", name: "@", value: "apex", ttl: 300, group: { type: "custom" } },
    ]);
    const records = await fake.provider.listRecords({ zone: "example.com" }, context);
    expect(records.map((record) => record.name)).toEqual([
      "example.com.example.com",
      "example.com",
    ]);
  });

  test("reads a full page of maximum-length values", async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      type: "TXT",
      name: `r${index}`,
      value: "x".repeat(65_535),
      ttl: 300,
      group: { type: "custom" },
    }));
    const mock = mockFetch(() => json({ items, total: 100 }));
    const records = await spaceship({ ...credentials, fetch: mock.fetch }).listRecords(
      { zone: "example.com" },
      context,
    );
    expect(records).toHaveLength(100);
  });

  test("honors a base URL, default TTL, and empty writes", async () => {
    const mock = mockFetch(() => new Response(null, { status: 204 }));
    const provider = spaceship({
      ...credentials,
      fetch: mock.fetch,
      baseUrl: "https://test.example/v1/",
      ttl: 120,
    });
    await provider.createRecords({ zone: "example.com", records: [] }, context);
    await provider.deleteRecords({ zone: "example.com", records: [] }, context);
    expect(mock.calls).toHaveLength(0);
    await provider.createRecords(
      { zone: "example.com", records: [{ type: "A", name: "example.com", value: "192.0.2.1" }] },
      context,
    );
    expect(mock.calls[0]?.url).toBe("https://test.example/v1/dns/records/example.com");
    expect(JSON.parse(String(mock.calls[0]?.init?.body)).items[0].ttl).toBe(120);
  });

  test.each([
    [401, "AUTHENTICATION_FAILED", false],
    [403, "PERMISSION_DENIED", false],
    [404, "DOMAIN_NOT_FOUND", false],
    [429, "RATE_LIMITED", true],
    [500, "PROVIDER_UNAVAILABLE", true],
    [400, "REQUEST_FAILED", false],
  ] as const)("maps HTTP %s", async (status, code, retryable) => {
    const mock = mockFetch(() =>
      json({ detail: "Specific provider detail", title: "Ignored title" }, status, {
        "retry-after": "12",
      }),
    );
    const provider = spaceship({ ...credentials, fetch: mock.fetch });
    await expect(provider.listRecords({ zone: "example.com" }, context)).rejects.toMatchObject({
      code,
      retryable,
      statusCode: status,
      provider: "spaceship",
      message: "spaceship request failed: Specific provider detail",
      retryAfter: 12000,
    });
  });

  test("maps force:false conflicts and other validation errors", async () => {
    const mock = mockFetch(() =>
      json({ detail: "Conflicting record", data: [{ field: "items", details: "Invalid" }] }, 422),
    );
    const provider = spaceship({ ...credentials, fetch: mock.fetch });
    await expect(
      provider.createRecords(
        { zone: "example.com", records: [{ type: "A", name: "example.com", value: "192.0.2.1" }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "DOMAIN_CONFLICT", statusCode: 422 });
    await expect(provider.listRecords({ zone: "example.com" }, context)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
      statusCode: 422,
    });
  });

  test("does not expose credentials echoed by the provider or network", async () => {
    for (const handler of [
      () => json({ detail: `${credentials.apiKey} ${credentials.apiSecret}` }, 401),
      () => {
        throw new Error(`${credentials.apiKey} ${credentials.apiSecret}`);
      },
      () => new Response(`${credentials.apiKey} ${credentials.apiSecret}`, { status: 200 }),
    ]) {
      const mock = mockFetch(handler);
      try {
        await spaceship({ ...credentials, fetch: mock.fetch }).listRecords(
          { zone: "example.com" },
          context,
        );
        throw new Error("Expected a rejection");
      } catch (error) {
        const exposed = `${String(error)} ${JSON.stringify(error)}`;
        expect(exposed).not.toContain(credentials.apiKey);
        expect(exposed).not.toContain(credentials.apiSecret);
      }
    }
  });

  test("maps network failures and forwards cancellation", async () => {
    const mock = mockFetch(() => {
      throw new Error("offline");
    });
    const provider = spaceship({ ...credentials, fetch: mock.fetch });
    await expect(provider.listRecords({ zone: "example.com" }, context)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.listRecords({ zone: "example.com" }, { ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED", retryable: false });
    expect(mock.calls.at(-1)?.init?.signal).toBe(controller.signal);
  });

  test("maps cancellation while reading the response body", async () => {
    const controller = new AbortController();
    const mock = mockFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(stream) {
              controller.abort();
              stream.error(new DOMException("Cancelled", "AbortError"));
            },
          }),
        ),
    );
    const provider = spaceship({ ...credentials, fetch: mock.fetch });
    await expect(
      provider.listRecords({ zone: "example.com" }, { ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED", retryable: false });
  });

  test.each([
    { items: [], total: 1 },
    { items: [] },
    { items: "invalid", total: 0 },
    { items: [], total: -1 },
    { items: [{}], total: 1 },
  ])("rejects malformed record pages", async (page) => {
    const mock = mockFetch(() => json(page));
    await expect(
      spaceship({ ...credentials, fetch: mock.fetch }).listRecords(
        { zone: "example.com" },
        context,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_FAILED" });
  });

  test("rejects malformed zone information", async () => {
    const mock = mockFetch(() => json({ nameservers: { provider: "basic", hosts: [null] } }));
    await expect(
      spaceship({ ...credentials, fetch: mock.fetch }).getZone!({ zone: "example.com" }, context),
    ).rejects.toMatchObject({ code: "REQUEST_FAILED" });
  });

  test("validates credentials and default TTL", () => {
    for (const options of [
      { ...credentials, apiKey: " " },
      { ...credentials, apiSecret: "" },
      ...[59, 3601, 1.5, NaN].map((ttl) => ({ ...credentials, ttl })),
    ])
      expect(() => spaceship(options)).toThrow(
        expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
      );
  });
});
