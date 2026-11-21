import { describe, expect, test } from "bun:test";
import {
  createDomainClient,
  createSubdomainClient,
  DEFAULT_RESERVED_LABELS,
  DomainSdkError,
} from "../../src";
import { memoryProvider } from "../../src/testing";

describe("subdomain client", () => {
  test("requires a domain client and base domain", () => {
    expect(() => createSubdomainClient(undefined as never)).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
    );
    expect(() =>
      createSubdomainClient({
        domainClient: createDomainClient({ provider: memoryProvider() }),
        baseDomain: "",
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  test("normalizes and scopes direct tenant labels", () => {
    const subdomains = createSubdomainClient({
      domainClient: createDomainClient({ provider: memoryProvider() }),
      baseDomain: " Customers.Example.COM. ",
      reservedLabels: ["www", "BÜCHER"],
    });

    expect(subdomains.baseDomain).toBe("customers.example.com");
    expect(subdomains.wildcardHostname).toBe("*.customers.example.com");
    expect(subdomains.toHostname(" Acme ")).toBe("acme.customers.example.com");
    expect(subdomains.toHostname("équipe")).toBe("xn--quipe-9ra.customers.example.com");
    expect(subdomains.fromHostname("ACME.customers.example.com.")).toBe("acme");

    for (const invalid of ["", "*", "a.b", "www", "bücher"]) {
      expect(() => subdomains.toHostname(invalid)).toThrow(DomainSdkError);
    }
    expect(() => subdomains.fromHostname("acme.example.com")).toThrow(DomainSdkError);
    expect(() => subdomains.fromHostname("nested.acme.customers.example.com")).toThrow(
      DomainSdkError,
    );
  });

  test("runs an individual subdomain lifecycle", async () => {
    const memory = memoryProvider();
    const subdomains = createSubdomainClient({
      domainClient: createDomainClient({ provider: memory }),
      baseDomain: "example.com",
    });

    expect((await subdomains.add("acme")).hostname).toBe("acme.example.com");
    expect((await subdomains.get("acme")).status).toBe("pending_dns");
    expect((await subdomains.verify("acme")).status).toBe("active");
    expect((await subdomains.refresh("acme")).hostname).toBe("acme.example.com");
    expect((await subdomains.waitUntilActive("acme", { timeoutMs: 0 })).status).toBe("active");
    await subdomains.remove("acme");
  });

  test("provisions a wildcard only for a capable provider", async () => {
    const unsupported = createSubdomainClient({
      domainClient: createDomainClient({ provider: memoryProvider() }),
      baseDomain: "example.com",
    });
    expect(unsupported.supportsWildcard).toBe(false);
    await expect(unsupported.provisionWildcard()).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });

    const memory = memoryProvider();
    const wildcardProvider = {
      ...memory,
      capabilities: { ...memory.capabilities, wildcardDomains: true },
    };
    const supported = createSubdomainClient({
      domainClient: createDomainClient({ provider: wildcardProvider }),
      baseDomain: "example.com",
    });

    expect(supported.supportsWildcard).toBe(true);
    expect((await supported.provisionWildcard()).hostname).toBe("*.example.com");
    memory.activate("*.example.com");
    expect((await supported.getWildcard()).status).toBe("active");
    expect((await supported.refreshWildcard()).status).toBe("active");
    expect((await supported.verifyWildcard()).status).toBe("active");
    expect((await supported.waitUntilWildcardActive({ timeoutMs: 0 })).status).toBe("active");
    wildcardProvider.capabilities.wildcardDomains = false;
    expect(supported.supportsWildcard).toBe(false);
    await expect(supported.refreshWildcard()).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });
    wildcardProvider.capabilities.wildcardDomains = true;
    await supported.removeWildcard();
  });

  test("reserves www, api, admin, and mail by default", () => {
    const subdomains = createSubdomainClient({
      domainClient: createDomainClient({ provider: memoryProvider() }),
      baseDomain: "example.com",
    });
    expect(DEFAULT_RESERVED_LABELS).toEqual(["www", "api", "admin", "mail"]);
    for (const label of ["www", "API", "admin", "mail", "_acme-challenge"])
      expect(() => subdomains.toHostname(label)).toThrow(
        expect.objectContaining({ code: "INVALID_HOSTNAME" }),
      );
    expect(subdomains.toHostname("acme")).toBe("acme.example.com");
  });

  test("reservedLabels replaces the defaults and [] opts out", () => {
    const domainClient = createDomainClient({ provider: memoryProvider() });
    const open = createSubdomainClient({
      domainClient,
      baseDomain: "example.com",
      reservedLabels: [],
    });
    expect(open.toHostname("www")).toBe("www.example.com");
    const extended = createSubdomainClient({
      domainClient,
      baseDomain: "example.com",
      reservedLabels: [...DEFAULT_RESERVED_LABELS, "billing"],
    });
    for (const label of ["www", "billing"])
      expect(() => extended.toHostname(label)).toThrow(DomainSdkError);
  });

  test("lists only tenant subdomains of the base domain", async () => {
    const memory = memoryProvider();
    const wildcardProvider = {
      ...memory,
      capabilities: { ...memory.capabilities, wildcardDomains: true },
    };
    const domainClient = createDomainClient({ provider: wildcardProvider });
    for (const hostname of [
      "acme.example.com",
      "beta.example.com",
      "www.example.com",
      "deep.acme.example.com",
      "*.example.com",
      "app.other.com",
      "example.com",
    ])
      await domainClient.add(hostname);
    const subdomains = createSubdomainClient({ domainClient, baseDomain: "example.com" });

    const all = await subdomains.list({ limit: 100 });
    expect(all.subdomains.map(({ label, domain }) => [label, domain.hostname])).toEqual([
      ["acme", "acme.example.com"],
      ["beta", "beta.example.com"],
    ]);
    expect(all.nextCursor).toBeUndefined();

    const labels: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await subdomains.list({ limit: 2, cursor });
      labels.push(...page.subdomains.map((subdomain) => subdomain.label));
      cursor = page.nextCursor;
    } while (cursor);
    expect(labels).toEqual(["acme", "beta"]);
  });
});
