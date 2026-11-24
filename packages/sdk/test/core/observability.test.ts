import { describe, expect, test } from "bun:test";
import {
  createDnsClient,
  createDomainClient,
  DomainSdkError,
  type DnsOperationEvent,
  type DomainOperationEvent,
} from "../../src";
import { memoryDnsProvider, memoryProvider } from "../../src/testing";

const fakeClock = () => {
  let now = 1_000;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    clock: {
      now: () => now,
      async sleep(ms: number) {
        now += ms;
      },
    },
  };
};

describe("DomainClient onOperation", () => {
  test("reports duration, attempts, and outcome for each operation", async () => {
    const memory = memoryProvider();
    const { clock, advance } = fakeClock();
    const events: DomainOperationEvent[] = [];
    const client = createDomainClient({
      provider: memory,
      clock,
      onOperation: (event) => events.push(event),
    });
    const add = memory.add.bind(memory);
    memory.add = async (input, context) => {
      advance(40);
      return add(input, context);
    };
    await client.add("app.customer.com");
    expect(events).toEqual([
      {
        operation: "add",
        provider: "memory",
        hostname: "app.customer.com",
        durationMs: 40,
        attempts: 1,
        outcome: "success",
      },
    ]);
  });

  test("counts retries and reports the normalized failure", async () => {
    const memory = memoryProvider();
    const { clock } = fakeClock();
    const events: DomainOperationEvent[] = [];
    const client = createDomainClient({
      provider: memory,
      clock,
      onOperation: (event) => events.push(event),
    });
    const unavailable = new DomainSdkError("PROVIDER_UNAVAILABLE", "Down.", {
      statusCode: 503,
      retryable: true,
      retryAfter: 100,
    });
    memory.get = () => Promise.reject(unavailable);
    await expect(client.get("app.customer.com")).rejects.toBe(unavailable);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      operation: "get",
      outcome: "failure",
      attempts: 3,
      durationMs: 200,
    });
    if (event?.outcome !== "failure") throw new Error("expected a failure event");
    expect(event.error).toBe(unavailable);
  });

  test("a throwing hook is logged and never changes the result", async () => {
    const warnings: string[] = [];
    const client = createDomainClient({
      provider: memoryProvider(),
      logger: { warn: (message) => warnings.push(message) },
      onOperation: () => {
        throw new Error("metrics backend down");
      },
    });
    expect((await client.add("app.customer.com")).hostname).toBe("app.customer.com");
    expect(warnings).toEqual(["Domain onOperation hook threw."]);
  });

  test("reports pre-dispatch validation and unsupported failures with zero attempts", async () => {
    const events: DomainOperationEvent[] = [];
    const memory = memoryProvider();
    const noList = {
      ...memory,
      list: undefined,
      capabilities: { ...memory.capabilities, list: false },
    };
    const client = createDomainClient({
      provider: noList,
      onOperation: (event) => events.push(event),
    });
    await expect(client.get("not a hostname")).rejects.toMatchObject({ code: "INVALID_HOSTNAME" });
    await expect(client.list()).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(
      events.map(({ operation, outcome, attempts }) => ({ operation, outcome, attempts })),
    ).toEqual([
      { operation: "get", outcome: "failure", attempts: 0 },
      { operation: "list", outcome: "failure", attempts: 0 },
    ]);
  });
});

describe("DnsClient onOperation", () => {
  test("reports each DNS operation with its zone", async () => {
    const events: DnsOperationEvent[] = [];
    const dns = createDnsClient({
      provider: memoryDnsProvider(),
      onOperation: (event) => events.push(event),
    });
    await dns.ensureRecords([{ type: "TXT", name: "_verify.example.com", value: "token" }]);
    await dns.listRecords("example.com");
    await expect(
      dns.ensureRecords([{ type: "A", name: "app.example.com", value: "192.0.2.1", ttl: 5 }]),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(
      events.map(({ operation, zone, outcome, attempts }) => ({
        operation,
        zone,
        outcome,
        attempts,
      })),
    ).toEqual([
      { operation: "ensureRecords", zone: "example.com", outcome: "success", attempts: 1 },
      { operation: "listRecords", zone: "example.com", outcome: "success", attempts: 1 },
      { operation: "ensureRecords", zone: "example.com", outcome: "failure", attempts: 1 },
    ]);
    for (const event of events) expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });
});
