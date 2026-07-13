import { describe, expect, test } from "bun:test";
import { createDomainClient, DomainSdkError } from "../../src";
import { createMockDnsRecord, memoryProvider } from "../../src/testing";

describe("domain client and memory provider", () => {
  test("rejects initialization in a browser environment", () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true });

    try {
      expect(() => createDomainClient({ provider: memoryProvider() })).toThrow(
        "Domain SDK is server-side only",
      );
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("supports the lifecycle and duplicate add", async () => {
    const memory = memoryProvider({ records: [createMockDnsRecord(), createMockDnsRecord()] });
    const domains = createDomainClient({ provider: memory });
    const added = await domains.add("APP.customer.com.");
    expect(added.hostname).toBe("app.customer.com");
    expect(added.records).toHaveLength(1);
    expect((await domains.add("app.customer.com")).id).toBe(added.id);
    expect((await domains.get("app.customer.com")).status).toBe("pending_dns");
    expect((await domains.verify("app.customer.com")).status).toBe("active");
    expect((await domains.refresh("app.customer.com")).certificate.status).toBe("active");
    expect((await domains.list()).domains).toHaveLength(1);
    await domains.remove("app.customer.com");
    await domains.remove("app.customer.com");
    await expect(domains.get("app.customer.com")).rejects.toMatchObject({
      code: "DOMAIN_NOT_FOUND",
    });
  });

  test("paginates", async () => {
    const client = createDomainClient({ provider: memoryProvider() });
    await client.add("a.example.com");
    await client.add("b.example.com");
    const first = await client.list({ limit: 1 });
    expect(first.nextCursor).toBe("1");
    expect((await client.list({ limit: 1, cursor: first.nextCursor })).domains[0]?.hostname).toBe(
      "b.example.com",
    );
  });

  test("waits sequentially and supports immediate activation", async () => {
    const memory = memoryProvider();
    const client = createDomainClient({ provider: memory });
    await client.add("app.customer.com");
    memory.activate("app.customer.com");
    const active = await client.waitUntilActive("app.customer.com", { timeoutMs: 0 });
    expect(active.status).toBe("active");
  });

  test("times out and aborts", async () => {
    const client = createDomainClient({ provider: memoryProvider() });
    await client.add("app.customer.com");
    await expect(
      client.waitUntilActive("app.customer.com", { timeoutMs: 1, intervalMs: 250 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.get("app.customer.com", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  test("throws for unsupported capabilities", async () => {
    const memory = memoryProvider();
    const provider = {
      ...memory,
      capabilities: { ...memory.capabilities, explicitVerification: false },
      verify: undefined,
    };
    const client = createDomainClient({ provider });
    expect(() => client.verify("app.customer.com")).toThrow(DomainSdkError);
  });

  test("logs only safe operational context", async () => {
    const events: Record<string, unknown>[] = [];
    const client = createDomainClient({
      provider: memoryProvider(),
      logger: {
        debug: (_message, context) => events.push(context ?? {}),
        info: (_message, context) => events.push(context ?? {}),
      },
    });
    await client.add("app.customer.com");
    expect(events).toEqual([
      { provider: "memory", operation: "add", hostname: "app.customer.com" },
      { provider: "memory", operation: "add", hostname: "app.customer.com" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/token|authorization|secret/i);
  });

  test("supports a coherent configurable initial active state", async () => {
    const client = createDomainClient({ provider: memoryProvider({ initialStatus: "active" }) });
    const domain = await client.add("app.customer.com");
    expect(domain).toMatchObject({
      status: "active",
      verification: { status: "verified" },
      certificate: { status: "active" },
    });
    expect(domain.records.every((record) => record.status === "valid")).toBe(true);
  });
});
