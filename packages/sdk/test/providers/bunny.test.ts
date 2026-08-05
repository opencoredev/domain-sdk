import { describe, expect, test } from "bun:test";
import { createDomainClient } from "../../src";
import { bunny, type BunnyOptions } from "../../src/providers/bunny";
import { json, mockFetch } from "../helpers/fetch";

interface MockHostname {
  Id: number;
  Value: string;
  IsSystemHostname?: boolean;
  HasCertificate?: boolean;
  CertificateProvisionType?: number;
  ForceSSL?: boolean;
}

interface SetupOptions {
  hostnames?: Omit<MockHostname, "Id">[];
  addHostname?: () => Response;
  loadFreeCertificate?: () => Response;
}

const SYSTEM: MockHostname = { Id: 1, Value: "domain-sdk.b-cdn.net", IsSystemHostname: true };

function setup(options: SetupOptions = {}) {
  let nextId = 100;
  let hostnames: MockHostname[] = (
    options.hostnames ?? [{ Value: "existing.customer.com", HasCertificate: true }]
  ).map((hostname) => ({ Id: nextId++, ...hostname }));

  const mock = mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as { Hostname?: string }) : undefined;

    if (url.pathname === "/pullzone/4321" && method === "GET")
      return json({ Id: 4321, Name: "domain-sdk", Hostnames: [SYSTEM, ...hostnames] });

    if (url.pathname === "/pullzone/4321/addHostname" && method === "POST") {
      if (options.addHostname) return options.addHostname();
      hostnames = [...hostnames, { Id: nextId++, Value: body!.Hostname!, HasCertificate: false }];
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/pullzone/4321/removeHostname" && method === "DELETE") {
      hostnames = hostnames.filter(
        (hostname) => hostname.Value.toLowerCase() !== body!.Hostname!.toLowerCase(),
      );
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/pullzone/loadFreeCertificate" && method === "GET") {
      if (options.loadFreeCertificate) return options.loadFreeCertificate();
      const target = url.searchParams.get("hostname")!.toLowerCase();
      hostnames = hostnames.map((hostname) =>
        hostname.Value.toLowerCase() === target
          ? { ...hostname, HasCertificate: true, CertificateProvisionType: 1 }
          : hostname,
      );
      return new Response(null, { status: 200 });
    }

    if (url.pathname === "/pullzone/4321/setForceSSL" && method === "POST") {
      hostnames = hostnames.map((hostname) =>
        hostname.Value.toLowerCase() === body!.Hostname!.toLowerCase()
          ? { ...hostname, ForceSSL: true }
          : hostname,
      );
      return new Response(null, { status: 204 });
    }

    return json({ Message: `Unhandled ${method} ${url.pathname}` }, 500);
  });

  return { ...mock, hostnames: () => hostnames };
}

function client(mock: ReturnType<typeof setup>, extra: Partial<BunnyOptions> = {}) {
  return createDomainClient({
    provider: bunny({ apiKey: "key", pullZoneId: 4321, fetch: mock.fetch, ...extra }),
  });
}

describe("bunny.net adapter", () => {
  test("adds, reads, lists, and removes pull-zone hostnames idempotently", async () => {
    const mock = setup();
    const domains = client(mock);

    const added = await domains.add("app.customer.com");
    expect(added).toMatchObject({ provider: "bunny", status: "pending_dns" });
    expect(added.records).toHaveLength(1);
    expect(added.records[0]).toMatchObject({
      type: "CNAME",
      name: "app.customer.com",
      value: "domain-sdk.b-cdn.net",
      purpose: "routing",
      required: true,
      status: "pending",
    });
    expect(added.certificate.status).toBe("pending");

    expect((await domains.add("app.customer.com")).id).toBe(added.id);
    expect(mock.calls.filter((call) => call.url.endsWith("/addHostname"))).toHaveLength(1);

    const existing = await domains.get("existing.customer.com");
    expect(existing.status).toBe("active");
    expect(existing.certificate.status).toBe("active");
    expect(existing.verification.status).toBe("verified");
    expect(existing.records[0]!.status).toBe("valid");

    await domains.remove("app.customer.com");
    await domains.remove("app.customer.com");
    expect(mock.hostnames().map((hostname) => hostname.Value)).toEqual(["existing.customer.com"]);
    expect(mock.calls.filter((call) => call.url.endsWith("/removeHostname"))).toHaveLength(1);
  });

  test("excludes the system hostname from reads and pages through the rest", async () => {
    const mock = setup({
      hostnames: [{ Value: "one.customer.com" }, { Value: "two.customer.com" }],
    });
    const domains = client(mock);

    const first = await domains.list({ limit: 1 });
    expect(first.domains.map((domain) => domain.hostname)).toEqual(["one.customer.com"]);
    expect(first.nextCursor).toBe("1");

    const second = await domains.list({ limit: 1, cursor: first.nextCursor });
    expect(second.domains.map((domain) => domain.hostname)).toEqual(["two.customer.com"]);
    expect(second.nextCursor).toBeUndefined();

    await expect(domains.get("domain-sdk.b-cdn.net")).rejects.toMatchObject({
      code: "DOMAIN_NOT_FOUND",
    });
  });

  test("falls back to the pull-zone name when no system hostname is returned", async () => {
    const mock = mockFetch(() =>
      json({
        Id: 4321,
        Name: "domain-sdk",
        Hostnames: [{ Id: 2, Value: "app.customer.com", HasCertificate: false }],
      }),
    );
    const domains = createDomainClient({
      provider: bunny({ apiKey: "key", pullZoneId: "4321", fetch: mock.fetch }),
    });
    expect((await domains.get("app.customer.com")).records[0]!.value).toBe("domain-sdk.b-cdn.net");
  });

  test("returns an apex routing instruction for apex domains", async () => {
    const mock = setup({ hostnames: [{ Value: "customer.com" }] });
    const record = (await client(mock).get("customer.com")).records[0]!;
    expect(record).toMatchObject({ type: "ALIAS", value: "domain-sdk.b-cdn.net" });
    expect(record.description).toContain("ALIAS");
  });

  test("verify issues a free certificate and reports the domain as active", async () => {
    const mock = setup({ hostnames: [{ Value: "app.customer.com", HasCertificate: false }] });
    const verified = await client(mock).verify("app.customer.com");

    const certificateCall = mock.calls.find((call) => call.url.includes("loadFreeCertificate"))!;
    expect(new URL(certificateCall.url).searchParams.get("hostname")).toBe("app.customer.com");
    expect(new URL(certificateCall.url).searchParams.has("useOnlyHttp01")).toBe(false);
    expect(verified.status).toBe("active");
    expect(verified.certificate).toMatchObject({ status: "active", issuer: "Let's Encrypt" });
    expect(mock.calls.some((call) => call.url.endsWith("/setForceSSL"))).toBe(false);
  });

  test("verify skips reissuing a certificate the hostname already has", async () => {
    const mock = setup({ hostnames: [{ Value: "app.customer.com", HasCertificate: true }] });
    expect((await client(mock).verify("app.customer.com")).status).toBe("active");
    expect(mock.calls.some((call) => call.url.includes("loadFreeCertificate"))).toBe(false);
  });

  test("verify uses DNS validation for wildcards and when explicitly allowed", async () => {
    const wildcardMock = setup({ hostnames: [{ Value: "*.customer.com" }] });
    await client(wildcardMock).verify("*.customer.com");
    const wildcardCall = wildcardMock.calls.find((call) =>
      call.url.includes("loadFreeCertificate"),
    )!;
    expect(new URL(wildcardCall.url).searchParams.get("useOnlyHttp01")).toBe("false");
    expect(new URL(wildcardCall.url).searchParams.get("hostname")).toBe("*.customer.com");

    const dnsMock = setup({ hostnames: [{ Value: "app.customer.com" }] });
    await client(dnsMock, { allowDnsValidation: true }).verify("app.customer.com");
    const dnsCall = dnsMock.calls.find((call) => call.url.includes("loadFreeCertificate"))!;
    expect(new URL(dnsCall.url).searchParams.get("useOnlyHttp01")).toBe("false");
  });

  test("verify forces SSL when the adapter is configured to", async () => {
    const mock = setup({ hostnames: [{ Value: "app.customer.com" }] });
    await client(mock, { forceSsl: true }).verify("app.customer.com");
    const call = mock.calls.find((item) => item.url.endsWith("/setForceSSL"))!;
    expect(JSON.parse(String(call.init?.body))).toEqual({
      Hostname: "app.customer.com",
      ForceSSL: true,
    });
    expect(mock.hostnames()[0]!.ForceSSL).toBe(true);
  });

  test("verify surfaces a retryable failure when the routing record does not resolve yet", async () => {
    const mock = setup({
      hostnames: [{ Value: "app.customer.com" }],
      loadFreeCertificate: () =>
        json({ ErrorKey: "certificate.validation_failed", Message: "DNS validation failed" }, 400),
    });
    await expect(client(mock).verify("app.customer.com")).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
      retryable: true,
    });
  });

  test("verify rejects a hostname that is not on the pull zone", async () => {
    const mock = setup();
    await expect(client(mock).verify("missing.customer.com")).rejects.toMatchObject({
      code: "DOMAIN_NOT_FOUND",
    });
    expect(mock.calls.some((call) => call.url.includes("loadFreeCertificate"))).toBe(false);
  });

  test("returns the hostname when a concurrent add already attached it", async () => {
    let attached = false;
    const mock = mockFetch((url) => {
      if (url.pathname === "/pullzone/4321/addHostname") {
        attached = true;
        return json({ ErrorKey: "hostname.taken", Message: "The hostname is already in use" }, 400);
      }
      return json({
        Id: 4321,
        Name: "domain-sdk",
        Hostnames: [
          SYSTEM,
          ...(attached ? [{ Id: 200, Value: "app.customer.com", HasCertificate: false }] : []),
        ],
      });
    });
    const added = await createDomainClient({
      provider: bunny({ apiKey: "key", pullZoneId: 4321, fetch: mock.fetch }),
    }).add("app.customer.com");
    expect(added).toMatchObject({ id: "200", hostname: "app.customer.com" });
  });

  test("maps an already-attached hostname to a conflict", async () => {
    const mock = setup({
      addHostname: () =>
        json({ ErrorKey: "hostname.taken", Message: "The hostname is already in use" }, 400),
    });
    await expect(client(mock).add("app.customer.com")).rejects.toMatchObject({
      code: "DOMAIN_CONFLICT",
      provider: "bunny",
    });
  });

  test("surfaces bunny.net error messages and retryable transport failures", async () => {
    const rejecting = mockFetch(() =>
      json({ ErrorKey: "authorization.failed", Message: "Invalid AccessKey" }, 401),
    );
    await expect(
      createDomainClient({
        provider: bunny({ apiKey: "key", pullZoneId: 4321, fetch: rejecting.fetch }),
      }).get("app.customer.com"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED", retryable: false });

    const rateLimited = mockFetch(() =>
      json({ Message: "Too many requests" }, 429, { "retry-after": "30" }),
    );
    await expect(
      createDomainClient({
        provider: bunny({ apiKey: "key", pullZoneId: 4321, fetch: rateLimited.fetch }),
      }).get("app.customer.com"),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfter: 30_000 });
  });

  test("reports a missing pull zone as a configuration problem", async () => {
    const missing = mockFetch(() => new Response(null, { status: 404 }));
    await expect(
      createDomainClient({
        provider: bunny({ apiKey: "key", pullZoneId: 4321, fetch: missing.fetch }),
      }).get("app.customer.com"),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  test("rejects invalid configuration, responses, and cursors", () => {
    expect(() => bunny({ apiKey: "", pullZoneId: 4321 })).toThrow();
    expect(() => bunny({ apiKey: "key", pullZoneId: "" })).toThrow();
    expect(() => bunny({ apiKey: "key", pullZoneId: "pz_4321" })).toThrow();
  });

  test("rejects a malformed pull-zone payload and an invalid list cursor", async () => {
    const malformed = mockFetch(() => json({ Id: 4321 }));
    await expect(
      createDomainClient({
        provider: bunny({ apiKey: "key", pullZoneId: 4321, fetch: malformed.fetch }),
      }).get("app.customer.com"),
    ).rejects.toMatchObject({ code: "REQUEST_FAILED" });

    for (const cursor of ["nope", "1junk", "-1", "1.5", "", "9007199254740993", "9".repeat(400)]) {
      await expect(client(setup()).list({ cursor })).rejects.toMatchObject({
        code: "REQUEST_FAILED",
      });
    }
  });

  test("authenticates with the AccessKey header", async () => {
    const mock = setup();
    await client(mock).get("existing.customer.com");
    expect((mock.calls[0]!.init?.headers as Record<string, string> | undefined)?.AccessKey).toBe(
      "key",
    );
  });
});
