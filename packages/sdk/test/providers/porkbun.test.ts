import { describe, expect, test } from "bun:test";
import { createDnsClient } from "../../src";
import type { DnsProviderContext } from "../../src/core/dns";
import { porkbun } from "../../src/providers/porkbun";
import { dnsProviderContract } from "../contract/dns-contract";
import { json, mockFetch } from "../helpers/fetch";

const context: DnsProviderContext = { logger: {} };
const credentials = { apiKey: "pk1_test", secretApiKey: "sk1_test" };
interface FakeRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: string;
  prio?: string;
}

function fakeApi(initial: FakeRecord[] = []) {
  const records = [...initial];
  let nextId = initial.length + 1;
  const mock = mockFetch((url, init) => {
    expect(url.origin).toBe("https://api.porkbun.com");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body.apikey).toBe(credentials.apiKey);
    expect(body.secretapikey).toBe(credentials.secretApiKey);
    const path = url.pathname.replace("/api/json/v3", "");
    if (path === "/dns/retrieve/example.com") return json({ status: "SUCCESS", records });
    if (path === "/domain/getNs/example.com")
      return json({ status: "SUCCESS", ns: ["Curitiba.NS.Porkbun.com.", "maceio.ns.porkbun.com"] });
    if (path === "/dns/create/example.com") {
      const name = body.name ? `${body.name}.example.com` : "example.com";
      if (
        records.some(
          (record) =>
            record.name === name && record.type === body.type && record.content === body.content,
        )
      )
        return json({ status: "ERROR", code: "DUPLICATE_RECORD" }, 400);
      const id = String(nextId++);
      records.push({ id, name, type: body.type, content: body.content, ttl: String(body.ttl) });
      return json({ status: "SUCCESS", id });
    }
    if (path.startsWith("/dns/delete/example.com/")) {
      const id = decodeURIComponent(path.split("/").at(-1)!);
      const index = records.findIndex((record) => record.id === id);
      if (index >= 0) records.splice(index, 1);
      return json({ status: "SUCCESS" });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  return { ...mock, records, provider: porkbun({ ...credentials, fetch: mock.fetch }) };
}

dnsProviderContract("porkbun", () => fakeApi().provider);

describe("porkbun DNS", () => {
  test("validates credentials and default TTL", () => {
    expect(() => porkbun({ ...credentials, apiKey: " " })).toThrow();
    expect(() => porkbun({ ...credentials, secretApiKey: "" })).toThrow();
    for (const ttl of [599, 86401, 600.5, Number.NaN])
      expect(() => porkbun({ ...credentials, ttl })).toThrow();
    expect(porkbun(credentials).capabilities).toEqual({
      recordTypes: ["A", "AAAA", "CNAME", "ALIAS", "TXT", "CAA"],
      ttl: { min: 600, max: 86400 },
      wholeZoneWrites: false,
      zoneInfo: true,
    });
  });

  test("creates apex, wildcard, nested and CAA records with exact request shapes", async () => {
    const api = fakeApi();
    const signal = new AbortController().signal;
    const provider = porkbun({ ...credentials, ttl: 900, fetch: api.fetch });
    const records = [
      { type: "A" as const, name: "example.com", value: "192.0.2.1" },
      { type: "CNAME" as const, name: "*.example.com", value: "target.example.net", ttl: 1200 },
      { type: "TXT" as const, name: "_acme.app.example.com", value: "Token" },
      { type: "CAA" as const, name: "example.com", value: '0 issue "letsencrypt.org"' },
    ];
    await provider.createRecords({ zone: "example.com", records }, { ...context, signal });
    expect(api.calls).toHaveLength(4);
    const keys = new Set<string>();
    for (const [index, call] of api.calls.entries()) {
      expect(call.url).toBe("https://api.porkbun.com/api/json/v3/dns/create/example.com");
      expect(call.init?.method).toBe("POST");
      expect(call.init?.signal).toBe(signal);
      const headers = new Headers(call.init?.headers);
      const key = headers.get("Idempotency-Key")!;
      expect(key).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      expect([...headers.keys()].sort()).toEqual(["accept", "content-type", "idempotency-key"]);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("accept")).toBe("application/json");
      keys.add(key);
      expect(JSON.parse(String(call.init?.body))).toEqual({
        apikey: credentials.apiKey,
        secretapikey: credentials.secretApiKey,
        name: ["", "*", "_acme.app", ""][index],
        type: records[index]!.type,
        content: records[index]!.value,
        ttl: records[index]!.ttl ?? 900,
      });
    }
    expect(keys.size).toBe(4);
  });

  test("reads every record including unsupported types and managed apex NS", async () => {
    const initial: FakeRecord[] = [
      {
        id: "1",
        name: "Example.COM.",
        type: "NS",
        content: "Curitiba.NS.Porkbun.com.",
        ttl: "600",
      },
      {
        id: "2",
        name: "child.example.com",
        type: "NS",
        content: "curitiba.ns.porkbun.com",
        ttl: "600",
      },
      { id: "3", name: "example.com", type: "NS", content: "ns.other.net", ttl: "600" },
      { id: "4", name: "example.com", type: "caa", content: "0 ISSUE letsencrypt.org", ttl: "900" },
      { id: "5", name: "example.com", type: "CAA", content: "unparseable", ttl: "900" },
      {
        id: "6",
        name: "example.com",
        type: "MX",
        content: "mail.example.net",
        ttl: "600",
        prio: "10",
      },
    ];
    for (let index = 0; index < 300; index++)
      initial.push({
        id: String(index + 7),
        name: `txt${index}.example.com`,
        type: "TXT",
        content: "x".repeat(100),
        ttl: "600",
      });
    const api = fakeApi(initial);
    const records = await api.provider.listRecords({ zone: "example.com" }, context);
    expect(records).toHaveLength(306);
    expect(records[0]).toMatchObject({ id: "1", name: "example.com", ttl: 600, editable: false });
    expect(records[1]?.editable).toBe(true);
    expect(records[2]?.editable).toBe(true);
    expect(records[3]).toMatchObject({ type: "CAA", value: '0 issue "letsencrypt.org"' });
    expect(records[4]?.value).toBe("unparseable");
    expect(records[5]).toMatchObject({ type: "MX", priority: 10, editable: true });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.url).toBe("https://api.porkbun.com/api/json/v3/dns/retrieve/example.com");
    expect(JSON.parse(String(api.calls[0]?.init?.body))).toEqual({
      apikey: credentials.apiKey,
      secretapikey: credentials.secretApiKey,
    });
  });

  test("parses zones larger than the default response limit", async () => {
    const initial: FakeRecord[] = Array.from({ length: 1500 }, (_, index) => ({
      id: String(index + 1),
      name: `txt${index}.example.com`,
      type: "TXT",
      content: "x".repeat(2000),
      ttl: "600",
    }));
    const records = await fakeApi(initial).provider.listRecords({ zone: "example.com" }, context);
    expect(records).toHaveLength(1500);
  });

  test("deletes only selected ids and validates ids before making changes", async () => {
    const api = fakeApi([
      { id: "1", name: "example.com", type: "TXT", content: "one", ttl: "600" },
      { id: "2", name: "example.com", type: "TXT", content: "two", ttl: "600" },
    ]);
    const records = await api.provider.listRecords({ zone: "example.com" }, context);
    await api.provider.deleteRecords({ zone: "example.com", records: [records[0]!] }, context);
    expect(api.records.map((record) => record.id)).toEqual(["2"]);
    expect(api.calls[1]?.url).toBe("https://api.porkbun.com/api/json/v3/dns/delete/example.com/1");
    expect(JSON.parse(String(api.calls[1]?.init?.body))).toEqual({
      apikey: credentials.apiKey,
      secretapikey: credentials.secretApiKey,
    });
    await expect(
      api.provider.deleteRecords(
        { zone: "example.com", records: [records[1]!, { ...records[0]!, id: undefined }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(api.calls).toHaveLength(2);
  });

  test("treats duplicate creates as success but not duplicate errors on other operations", async () => {
    const mock = mockFetch(() => json({ status: "ERROR", code: "DUPLICATE_RECORD" }, 400));
    const provider = porkbun({ ...credentials, fetch: mock.fetch });
    await provider.createRecords(
      { zone: "example.com", records: [{ type: "A", name: "example.com", value: "192.0.2.1" }] },
      context,
    );
    await expect(provider.listRecords({ zone: "example.com" }, context)).rejects.toMatchObject({
      code: "REQUEST_FAILED",
    });
  });

  test("normalizes delegated nameservers and uses only the zone endpoint", async () => {
    const api = fakeApi();
    expect(await api.provider.getZone!({ zone: "example.com" }, context)).toEqual({
      name: "example.com",
      provider: "porkbun",
      authoritative: true,
      nameservers: ["curitiba.ns.porkbun.com", "maceio.ns.porkbun.com"],
    });
    expect(api.calls[0]?.url).toBe("https://api.porkbun.com/api/json/v3/domain/getNs/example.com");
    for (const ns of [
      [],
      ["ns.other.net"],
      ["curitiba.ns.porkbun.com", "ns.other.net"],
      ["evilporkbun.com"],
    ]) {
      const mock = mockFetch(() => json({ status: "SUCCESS", ns }));
      expect(
        (
          await porkbun({ ...credentials, fetch: mock.fetch }).getZone!(
            { zone: "example.com" },
            context,
          )
        ).authoritative,
      ).toBe(false);
    }
  });

  test("supports baseUrl override and sandbox keys without a separate endpoint", async () => {
    const mock = mockFetch(() => json({ status: "SUCCESS", records: [] }));
    await porkbun({
      ...credentials,
      apiKey: "pk1_sb_test",
      baseUrl: "https://test.example/api/",
      fetch: mock.fetch,
    }).listRecords({ zone: "example.com" }, context);
    expect(mock.calls[0]?.url).toBe("https://test.example/api/dns/retrieve/example.com");
    expect(JSON.parse(String(mock.calls[0]?.init?.body)).apikey).toBe("pk1_sb_test");
  });

  test("maps HTTP and JSON errors without leaking credentials", async () => {
    const cases = [
      { status: 200, message: "Invalid API key", code: "AUTHENTICATION_FAILED" },
      { status: 400, message: "Invalid secret API key", code: "AUTHENTICATION_FAILED" },
      { status: 200, message: "Domain is not opted in to API access", code: "PERMISSION_DENIED" },
      { status: 400, message: "Permission denied", code: "PERMISSION_DENIED" },
      { status: 400, message: "Domain not found", code: "DOMAIN_NOT_FOUND" },
      { status: 400, message: "Invalid record", code: "INVALID_CONFIGURATION" },
      { status: 401, message: "Rejected", code: "AUTHENTICATION_FAILED" },
      { status: 403, message: "Rejected", code: "PERMISSION_DENIED" },
      { status: 404, message: "Rejected", code: "DOMAIN_NOT_FOUND" },
      { status: 429, message: "Rejected", code: "RATE_LIMITED" },
      { status: 503, message: "Invalid API key", code: "PROVIDER_UNAVAILABLE" },
      { status: 400, message: "Rejected", code: "REQUEST_FAILED" },
    ];
    for (const entry of cases) {
      const mock = mockFetch(() =>
        json(
          {
            status: "ERROR",
            message: `${entry.message}: ${credentials.apiKey} ${credentials.secretApiKey}`,
          },
          entry.status,
          { "retry-after": "12" },
        ),
      );
      const result = await porkbun({ ...credentials, fetch: mock.fetch })
        .listRecords({ zone: "example.com" }, context)
        .catch((error: unknown) => error);
      expect(result).toMatchObject({
        code: entry.code,
        provider: "porkbun",
        statusCode: entry.status,
        retryable: entry.status === 429 || entry.status === 503,
        retryAfter: 12000,
      });
      expect(String(result)).not.toContain(credentials.apiKey);
      expect(String(result)).not.toContain(credentials.secretApiKey);
      expect(JSON.stringify(result)).not.toContain(credentials.apiKey);
      if (entry.code === "PERMISSION_DENIED") expect(String(result)).toContain("Enable API Access");
    }
  });

  test("maps transport failures and passes abort signals", async () => {
    const controller = new AbortController();
    const mock = mockFetch((_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      throw new Error(credentials.secretApiKey);
    });
    const provider = porkbun({ ...credentials, fetch: mock.fetch });
    await expect(
      provider.listRecords({ zone: "example.com" }, { ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    controller.abort();
    await expect(
      provider.listRecords({ zone: "example.com" }, { ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED", retryable: false });
  });

  test("rejects malformed success responses and preserves HTTP failure classification", async () => {
    for (const response of [
      json({ status: "SUCCESS" }),
      json({ records: [] }),
      new Response(credentials.secretApiKey),
    ]) {
      const mock = mockFetch(() => response);
      await expect(
        porkbun({ ...credentials, fetch: mock.fetch }).listRecords(
          { zone: "example.com" },
          context,
        ),
      ).rejects.toMatchObject({ code: "REQUEST_FAILED", provider: "porkbun" });
    }
    const mock = mockFetch(() => new Response("unavailable", { status: 503 }));
    await expect(
      porkbun({ ...credentials, fetch: mock.fetch }).listRecords({ zone: "example.com" }, context),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });

  test("client rejects ANAME and TTLs below the Porkbun minimum", async () => {
    const api = fakeApi();
    const dns = createDnsClient({ provider: api.provider });
    await expect(
      dns.ensureRecords([{ type: "ANAME", name: "example.com", value: "target.example.net" }]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      dns.ensureRecords([{ type: "A", name: "example.com", value: "192.0.2.1", ttl: 599 }]),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(api.calls).toHaveLength(0);
  });
});
