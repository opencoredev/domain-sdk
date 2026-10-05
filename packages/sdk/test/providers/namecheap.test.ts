import { describe, expect, test } from "bun:test";

import { createDnsClient } from "../../src/core/dns";
import { namecheap } from "../../src/providers/namecheap";
import { dnsProviderContract } from "../contract/dns-contract";
import { mockFetch } from "../helpers/fetch";

interface FakeHost {
  HostId?: string;
  Name: string;
  Type: string;
  Address: string;
  MXPref?: string;
  TTL: string;
}

const credentials = { apiUser: "account", apiKey: "secret-key", clientIp: "192.0.2.10" };
const context = { logger: {} };
const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const xml = (content: string, status = "OK", httpStatus = 200, headers?: HeadersInit) =>
  new Response(
    `<?xml version="1.0"?><ApiResponse Status="${status}"><Errors/><CommandResponse>${content}</CommandResponse></ApiResponse>`,
    { status: httpStatus, headers },
  );
const xmlError = (number: string, message: string, headers?: HeadersInit) =>
  new Response(
    `<ApiResponse Status="ERROR"><Errors><Error Number="${number}">${escapeXml(message)}</Error></Errors></ApiResponse>`,
    { headers },
  );

function fake(
  initial: FakeHost[] = [],
  settings: {
    authoritative?: boolean;
    emailType?: string;
    ignoreWrites?: boolean;
    corruptPreserved?: boolean;
    lowercasePreserved?: boolean;
  } = {},
) {
  let hosts = initial.map((host, index) => ({ ...host, HostId: host.HostId ?? String(index + 1) }));
  let nextId = hosts.length + 1;
  const forms: URLSearchParams[] = [];
  const transport = mockFetch((_url, init) => {
    const form = new URLSearchParams(String(init?.body));
    forms.push(form);
    const command = form.get("Command");
    const domain = `${form.get("SLD")}.${form.get("TLD")}`;
    const emailType = settings.emailType ?? "MX";
    const authoritative = settings.authoritative ?? true;
    if (command === "namecheap.domains.dns.getList")
      return xml(
        `<DomainDNSGetListResult Domain="${domain}" IsUsingOurDNS="${authoritative}"><Nameserver>DNS1.REGISTRAR-SERVERS.COM.</Nameserver><Nameserver>dns2.registrar-servers.com</Nameserver></DomainDNSGetListResult>`,
      );
    if (command === "namecheap.domains.dns.getHosts")
      return xml(
        `<DomainDNSGetHostsResult Domain="${domain}" EmailType="${emailType}" IsUsingOurDNS="${authoritative}">${hosts
          .map(
            (host) =>
              `<host ${Object.entries(host)
                .map(([key, value]) => `${key}="${escapeXml(value)}"`)
                .join(" ")}/>`,
          )
          .join("")}</DomainDNSGetHostsResult>`,
      );
    if (command === "namecheap.domains.dns.setHosts") {
      expect(form.get("EmailType")).toBe(emailType);
      if (!settings.ignoreWrites) {
        const next: typeof hosts = [];
        for (let index = 1; form.has(`HostName${index}`); index++) {
          const host: FakeHost = {
            Name: form.get(`HostName${index}`)!,
            Type: form.get(`RecordType${index}`)!,
            Address: form.get(`Address${index}`)!,
            TTL: form.get(`TTL${index}`)!,
          };
          host.MXPref = form.get(`MXPref${index}`) ?? "10";
          const previous = hosts.find(
            (item) =>
              item.Name === host.Name && item.Type === host.Type && item.Address === host.Address,
          );
          next.push({ ...host, HostId: previous?.HostId ?? String(nextId++) });
        }
        hosts = next;
        if (settings.corruptPreserved && hosts[0]) hosts[0].Address = "lost-value";
        if (settings.lowercasePreserved && hosts[0])
          hosts[0].Address = hosts[0].Address.toLowerCase();
      }
      return xml(`<DomainDNSSetHostsResult Domain="${domain}" IsSuccess="true"/>`);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  return { ...transport, forms };
}

dnsProviderContract("namecheap", () => namecheap({ ...credentials, fetch: fake().fetch }));

describe("namecheap DNS adapter", () => {
  test("uses POST form bodies and splits multipart suffixes", async () => {
    const api = fake();
    const controller = new AbortController();
    const provider = namecheap({
      ...credentials,
      userName: "delegated-account",
      sandbox: true,
      fetch: api.fetch,
    });
    await provider.getZone!({ zone: "example.co.uk" }, { ...context, signal: controller.signal });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toEqual({
      url: "https://api.sandbox.namecheap.com/xml.response",
      init: {
        method: "POST",
        headers: { accept: "application/xml", "content-type": "application/x-www-form-urlencoded" },
        body: "ApiUser=account&ApiKey=secret-key&UserName=delegated-account&ClientIp=192.0.2.10&Command=namecheap.domains.dns.getList&SLD=example&TLD=co.uk",
        signal: controller.signal,
      },
    });
    expect(provider.capabilities).toEqual({
      recordTypes: ["A", "AAAA", "ALIAS", "CAA", "CNAME", "TXT"],
      ttl: { min: 60, max: 60000 },
      wholeZoneWrites: true,
      zoneInfo: true,
    });
  });

  test("lists every type in one response, with normalized owners and CAA", async () => {
    const api = fake([
      { Name: "@", Type: "A", Address: "192.0.2.1", TTL: "1800" },
      { Name: "WWW", Type: "CNAME", Address: "target.example.net.", TTL: "600" },
      { Name: "@", Type: "MX", Address: "mail.example.net.", MXPref: "10", TTL: "3600" },
      { Name: "@", Type: "CAA", Address: "0 ISSUE letsencrypt.org", TTL: "1800" },
      { Name: "_Verify", Type: "TXT", Address: 'a&b <c> "value"', TTL: "60" },
      { Name: "redirect", Type: "URL", Address: "https://example.net/path", TTL: "1800" },
      { Name: "frame", Type: "FRAME", Address: "https://example.net", TTL: "1800" },
      { Name: "delegated", Type: "NS", Address: "ns.example.net.", TTL: "1800" },
    ]);
    const records = await namecheap({ ...credentials, fetch: api.fetch }).listRecords(
      { zone: "example.com" },
      context,
    );
    expect(records).toHaveLength(8);
    expect(records.every((record) => record.editable && typeof record.ttl === "number")).toBe(true);
    expect(records[1]).toMatchObject({ name: "www.example.com", value: "target.example.net." });
    expect(records[2]).toMatchObject({ type: "MX", priority: 10 });
    expect(records[3]?.value).toBe('0 issue "letsencrypt.org"');
    expect(records[4]).toMatchObject({ name: "_verify.example.com", value: 'a&b <c> "value"' });
    expect(api.calls).toHaveLength(1);
  });

  test("preserves all unrelated hosts and MXE mail mode in both mutations", async () => {
    const initial = [
      { Name: "@", Type: "MX", Address: "mail.example.net.", MXPref: "20", TTL: "3600" },
      { Name: "redirect", Type: "URL", Address: "https://example.net/?a=1&b=2", TTL: "1800" },
      { Name: "frame", Type: "FRAME", Address: "https://example.net", TTL: "1800" },
      { Name: "delegated", Type: "NS", Address: "NS.example.net.", TTL: "600" },
    ];
    const api = fake(initial, { emailType: "MXE" });
    const provider = namecheap({ ...credentials, ttl: 900, fetch: api.fetch });
    await provider.createRecords(
      {
        zone: "example.com",
        records: [
          { type: "TXT", name: "example.com", value: "verification" },
          { type: "AAAA", name: "app.example.com", value: "2001:db8::1", ttl: 60 },
        ],
      },
      context,
    );
    const firstWrite = api.forms[1]!;
    expect(Object.fromEntries(firstWrite)).toMatchObject({
      EmailType: "MXE",
      HostName1: "@",
      RecordType1: "MX",
      Address1: "mail.example.net.",
      MXPref1: "20",
      TTL1: "3600",
      HostName2: "redirect",
      RecordType2: "URL",
      Address2: initial[1]!.Address,
      HostName4: "delegated",
      Address4: "NS.example.net.",
      HostName5: "@",
      RecordType5: "TXT",
      Address5: "verification",
      TTL5: "900",
      HostName6: "app",
      RecordType6: "AAAA",
      Address6: "2001:db8::1",
      TTL6: "60",
    });
    expect(firstWrite.has("HostId1")).toBe(false);
    expect(firstWrite.has("HostName7")).toBe(false);
    expect(api.forms.map((form) => form.get("Command"))).toEqual([
      "namecheap.domains.dns.getHosts",
      "namecheap.domains.dns.setHosts",
      "namecheap.domains.dns.getHosts",
    ]);
    const listed = await provider.listRecords({ zone: "example.com" }, context);
    await provider.deleteRecords({ zone: "example.com", records: [listed[4]!] }, context);
    const after = await provider.listRecords({ zone: "example.com" }, context);
    expect(after).toHaveLength(5);
    expect(after.slice(0, 4)).toEqual(listed.slice(0, 4));
    expect(after[4]).toMatchObject({ type: "AAAA", value: "2001:db8::1" });
  });

  test("serializes concurrent writes and protects stale deletion requests", async () => {
    const api = fake();
    const provider = namecheap({ ...credentials, fetch: api.fetch });
    await Promise.all(
      ["first", "second", "third"].map((value) =>
        provider.createRecords(
          {
            zone: "example.com",
            records: [{ type: "TXT", name: "example.com", value }],
          },
          context,
        ),
      ),
    );
    const records = await provider.listRecords({ zone: "example.com" }, context);
    expect(records.map((record) => record.value)).toEqual(["first", "second", "third"]);
    await provider.deleteRecords(
      { zone: "example.com", records: [{ ...records[0]!, value: "changed" }] },
      context,
    );
    expect(await provider.listRecords({ zone: "example.com" }, context)).toEqual(records);
  });

  test("deletes one of several identical hosts that lack host ids", async () => {
    const twin = { HostId: "", Name: "@", Type: "TXT", Address: "token", TTL: "1800" };
    const api = fake([twin, { ...twin }]);
    const provider = namecheap({ ...credentials, fetch: api.fetch });
    const [first] = await provider.listRecords({ zone: "example.com" }, context);
    await provider.deleteRecords({ zone: "example.com", records: [first!] }, context);
    expect(await provider.listRecords({ zone: "example.com" }, context)).toHaveLength(1);
  });

  test("verifies additions and preserved records after writing", async () => {
    for (const settings of [{ ignoreWrites: true }, { corruptPreserved: true }]) {
      const api = fake(
        [{ Name: "@", Type: "MX", Address: "mail.example.net.", TTL: "1800", MXPref: "10" }],
        settings,
      );
      const provider = namecheap({ ...credentials, fetch: api.fetch });
      await expect(
        provider.createRecords(
          {
            zone: "example.com",
            records: [{ type: "TXT", name: "example.com", value: "verification" }],
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    }
  });

  test("detects case-sensitive corruption of preserved redirect and text values", async () => {
    for (const type of ["URL", "FRAME", "TXT", "URL301"]) {
      const api = fake(
        [
          {
            Name: "redirect",
            Type: type,
            Address: "https://example.net/CaseSensitive?Token=AbC",
            TTL: "1800",
          },
        ],
        { lowercasePreserved: true },
      );
      await expect(
        namecheap({ ...credentials, fetch: api.fetch }).createRecords(
          {
            zone: "example.com",
            records: [{ type: "A", name: "app.example.com", value: "192.0.2.1" }],
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    }
  });

  test("caps response ingestion and cancels an oversized stream", async () => {
    let cancelled = false;
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(262144).fill(32));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const api = mockFetch(() => new Response(stream));
    await expect(
      namecheap({ ...credentials, fetch: api.fetch }).listRecords({ zone: "example.com" }, context),
    ).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    expect(cancelled).toBe(true);
    expect(reads).toBe(5);
  });

  test("decodes multibyte UTF-8 split across response chunks", async () => {
    const response = `<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult IsUsingOurDNS="true"><host Name="@" Type="TXT" Address="café" TTL="1800"/></DomainDNSGetHostsResult></CommandResponse></ApiResponse>`;
    const bytes = new TextEncoder().encode(response);
    let position = 0;
    const api = mockFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (position === bytes.length) controller.close();
              else controller.enqueue(bytes.slice(position, ++position));
            },
          }),
        ),
    );
    const records = await namecheap({ ...credentials, fetch: api.fetch }).listRecords(
      { zone: "example.com" },
      context,
    );
    expect(records[0]?.value).toBe("café");
  });

  test("does not expose an API error's credential-bearing number attribute", async () => {
    const api = mockFetch(() => xmlError("secret-key", "rejected"));
    try {
      await namecheap({ ...credentials, fetch: api.fetch }).listRecords(
        { zone: "example.com" },
        context,
      );
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "REQUEST_FAILED", details: undefined });
      expect(JSON.stringify(error)).not.toContain("secret-key");
    }
  });

  test("reports delegation and refuses to mutate non-BasicDNS zones", async () => {
    const api = fake([], { authoritative: false });
    const provider = namecheap({ ...credentials, fetch: api.fetch });
    expect(await provider.getZone!({ zone: "example.com" }, context)).toEqual({
      name: "example.com",
      provider: "namecheap",
      authoritative: false,
      nameservers: ["dns1.registrar-servers.com", "dns2.registrar-servers.com"],
    });
    await expect(
      provider.createRecords(
        { zone: "example.com", records: [{ type: "TXT", name: "example.com", value: "verify" }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(api.forms.some((form) => form.get("Command")?.endsWith("setHosts"))).toBe(false);
  });

  test.each([
    ["1011102", "Invalid API key", "AUTHENTICATION_FAILED", false],
    ["1011150", "Authentication failed", "AUTHENTICATION_FAILED", false],
    ["1011150", "IP is not whitelisted", "PERMISSION_DENIED", false],
    ["2019166", "Domain not found", "DOMAIN_NOT_FOUND", false],
    ["2016166", "Domain not found", "DOMAIN_NOT_FOUND", false],
    ["2030288", "DNS unavailable", "INVALID_CONFIGURATION", false],
    ["999", "Too many requests", "RATE_LIMITED", true],
    ["999", "secret-key account 192.0.2.10", "REQUEST_FAILED", false],
  ])("maps XML error %s: %s", async (number, message, code, retryable) => {
    const api = mockFetch(() =>
      xmlError(number as string, message as string, { "retry-after": "12" }),
    );
    const provider = namecheap({ ...credentials, fetch: api.fetch });
    try {
      await provider.listRecords({ zone: "example.com" }, context);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toMatchObject({
        code,
        retryable,
        provider: "namecheap",
        statusCode: 200,
        retryAfter: 12000,
      });
      expect(JSON.stringify(error)).not.toContain("secret-key");
      expect(String(error)).not.toContain("secret-key");
    }
  });

  test.each([
    [405, "RATE_LIMITED", true],
    [429, "RATE_LIMITED", true],
    [503, "PROVIDER_UNAVAILABLE", true],
    [401, "AUTHENTICATION_FAILED", false],
    [403, "PERMISSION_DENIED", false],
    [404, "DOMAIN_NOT_FOUND", false],
    [400, "REQUEST_FAILED", false],
  ])("maps HTTP %s before parsing XML", async (status, code, retryable) => {
    const api = mockFetch(
      () => new Response("Not XML", { status: status as number, headers: { "retry-after": "5" } }),
    );
    await expect(
      namecheap({ ...credentials, fetch: api.fetch }).listRecords({ zone: "example.com" }, context),
    ).rejects.toMatchObject({ code, retryable, retryAfter: 5000 });
  });

  test("maps network and aborted failures without exposing credentials", async () => {
    const api = mockFetch(() => {
      throw new Error("secret-key");
    });
    const provider = namecheap({ ...credentials, fetch: api.fetch });
    await expect(provider.listRecords({ zone: "example.com" }, context)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      cause: undefined,
    });
    const signal = AbortSignal.abort();
    await expect(
      provider.listRecords({ zone: "example.com" }, { ...context, signal }),
    ).rejects.toMatchObject({ code: "ABORTED", retryable: false });
  });

  test("a failed queued write does not block later writes", async () => {
    const api = fake();
    let fail = true;
    const transport = mockFetch((url, init) => {
      if (fail) {
        fail = false;
        return xmlError("999", "temporary failure");
      }
      return api.fetch(url, init);
    });
    const provider = namecheap({ ...credentials, fetch: transport.fetch });
    const input = {
      zone: "example.com",
      records: [{ type: "TXT" as const, name: "example.com", value: "verify" }],
    };
    const first = provider.createRecords(input, context);
    const second = provider.createRecords(input, context);
    await expect(first).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    await second;
    expect(await provider.listRecords({ zone: "example.com" }, context)).toHaveLength(1);
  });

  test("rejects malformed responses and reports unsuccessful setHosts", async () => {
    for (const response of [
      "not xml",
      '<ApiResponse Status="OK"><CommandResponse/></ApiResponse>',
      '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult><host Name="@" Type="A" Address="1.2.3.4" TTL="oops"/></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult><host Name="@" Type="A" Address="1.2.3.4" TTL="1800"/></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult IsUsingOurDNS="maybe"/></CommandResponse></ApiResponse>',
      new Uint8Array([
        ...new TextEncoder().encode(
          '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult IsUsingOurDNS="true"><host Name="@" Type="TXT" Address="',
        ),
        0xff,
        ...new TextEncoder().encode(
          '" TTL="1800"/></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
        ),
      ]),
    ]) {
      const api = mockFetch(() => new Response(response));
      await expect(
        namecheap({ ...credentials, fetch: api.fetch }).listRecords(
          { zone: "example.com" },
          context,
        ),
      ).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    }
    const api = fake();
    const transport = mockFetch((url, init) =>
      new URLSearchParams(String(init?.body)).get("Command")?.endsWith("setHosts")
        ? xml('<DomainDNSSetHostsResult IsSuccess="false"/>')
        : api.fetch(url, init),
    );
    await expect(
      namecheap({ ...credentials, fetch: transport.fetch }).createRecords(
        { zone: "example.com", records: [{ type: "A", name: "example.com", value: "192.0.2.1" }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_FAILED" });
  });

  test("validates credentials, IPv4 and default TTL; client rejects unsupported types", async () => {
    for (const options of [
      { apiKey: "" },
      { apiUser: "" },
      { userName: "" },
      { clientIp: "::1" },
      { ttl: 59 },
      { ttl: 60001 },
      { ttl: 60.5 },
    ])
      expect(() => namecheap({ ...credentials, ...options })).toThrow();
    const api = fake();
    const dns = createDnsClient({ provider: namecheap({ ...credentials, fetch: api.fetch }) });
    await expect(
      dns.ensureRecords([{ type: "ANAME", name: "example.com", value: "target.example.net" }]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      dns.ensureRecords([{ type: "A", name: "example.com", value: "192.0.2.1", ttl: 59 }]),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(api.calls).toHaveLength(0);
    await expect(dns.listRecords("sub.example.com")).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
  });
});
