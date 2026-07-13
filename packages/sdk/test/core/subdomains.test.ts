import { describe, expect, test } from "bun:test";
import { createDomainClient, createSubdomainClient, DomainSdkError } from "../../src";
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
    expect(() => unsupported.provisionWildcard()).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_OPERATION" }),
    );

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
    expect((await supported.verifyWildcard()).status).toBe("active");
    expect((await supported.waitUntilWildcardActive({ timeoutMs: 0 })).status).toBe("active");
    await supported.removeWildcard();
  });
});
