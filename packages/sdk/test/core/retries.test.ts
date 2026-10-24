import { describe, expect, test } from "bun:test";
import { createDnsClient, createDomainClient, DomainSdkError } from "../../src";
import type { DnsZoneLock } from "../../src";
import { memoryDnsProvider, memoryProvider } from "../../src/testing";

const fakeClock = () => {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      now: () => now,
      async sleep(ms: number) {
        sleeps.push(ms);
        now += ms;
      },
    },
  };
};

const rateLimited = (retryAfter?: number) =>
  new DomainSdkError("RATE_LIMITED", "Slow down.", {
    statusCode: 429,
    retryable: true,
    retryAfter,
  });
const unavailable = () =>
  new DomainSdkError("PROVIDER_UNAVAILABLE", "Down.", { statusCode: 503, retryable: true });

/** Make the first provider.get calls throw the given errors. */
const failGets = (memory: ReturnType<typeof memoryProvider>, errors: DomainSdkError[]) => {
  const get = memory.get.bind(memory);
  let calls = 0;
  memory.get = (input, context) => {
    calls += 1;
    const error = errors.shift();
    return error ? Promise.reject(error) : get(input, context);
  };
  return () => calls;
};

describe("createDomainClient retries", () => {
  test("retries a 429 after Retry-After, then a 503 with jittered backoff", async () => {
    const memory = memoryProvider();
    const { sleeps, clock } = fakeClock();
    const client = createDomainClient({ provider: memory, clock });
    await client.add("app.customer.com");
    const calls = failGets(memory, [rateLimited(1_500), unavailable()]);
    expect((await client.get("app.customer.com")).hostname).toBe("app.customer.com");
    expect(calls()).toBe(3);
    expect(sleeps[0]).toBe(1_500);
    expect(sleeps[1]).toBeGreaterThanOrEqual(0);
    expect(sleeps[1]).toBeLessThanOrEqual(500);
  });

  test("gives up after maxAttempts with the last error", async () => {
    const memory = memoryProvider();
    const { sleeps, clock } = fakeClock();
    const client = createDomainClient({ provider: memory, clock, retry: { maxAttempts: 2 } });
    await client.add("app.customer.com");
    const calls = failGets(memory, [unavailable(), rateLimited(20_000), unavailable()]);
    await expect(client.get("app.customer.com")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfter: 20_000,
    });
    expect(calls()).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  test("does not retry permanent failures", async () => {
    const memory = memoryProvider();
    const { sleeps, clock } = fakeClock();
    const client = createDomainClient({ provider: memory, clock });
    await expect(client.get("missing.customer.com")).rejects.toMatchObject({
      code: "DOMAIN_NOT_FOUND",
    });
    expect(sleeps).toEqual([]);
  });
});

describe("waitUntilActive backoff", () => {
  test("grows the polling interval by backoffFactor up to maxIntervalMs", async () => {
    const memory = memoryProvider();
    const { sleeps, clock } = fakeClock();
    const client = createDomainClient({ provider: memory, clock });
    await client.add("app.customer.com");
    let polls = 0;
    const active = await client.waitUntilActive("app.customer.com", {
      timeoutMs: 600_000,
      onStatus: () => {
        if (++polls === 6) memory.activate("app.customer.com");
      },
    });
    expect(active.status).toBe("active");
    expect(sleeps).toEqual([5_000, 7_500, 11_250, 16_875, 25_312.5, 30_000]);
  });

  test("polls at a fixed interval when backoffFactor is 1", async () => {
    const memory = memoryProvider();
    const { sleeps, clock } = fakeClock();
    const client = createDomainClient({ provider: memory, clock });
    await client.add("app.customer.com");
    let polls = 0;
    await client.waitUntilActive("app.customer.com", {
      intervalMs: 1_000,
      backoffFactor: 1,
      onStatus: () => {
        if (++polls === 3) memory.activate("app.customer.com");
      },
    });
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
  });

  test("jitter keeps each delay between half and all of the backoff", async () => {
    const memory = memoryProvider();
    const { sleeps, clock } = fakeClock();
    const client = createDomainClient({ provider: memory, clock });
    await client.add("app.customer.com");
    let polls = 0;
    await client.waitUntilActive("app.customer.com", {
      intervalMs: 1_000,
      backoffFactor: 2,
      jitter: true,
      onStatus: () => {
        if (++polls === 4) memory.activate("app.customer.com");
      },
    });
    [1_000, 2_000, 4_000].forEach((backoff, index) => {
      expect(sleeps[index]).toBeGreaterThanOrEqual(backoff / 2);
      expect(sleeps[index]).toBeLessThanOrEqual(backoff);
    });
  });

  test("polls once per attempt and honors Retry-After from a transient failure", async () => {
    const memory = memoryProvider();
    const { sleeps, clock } = fakeClock();
    const client = createDomainClient({ provider: memory, clock });
    await client.add("app.customer.com");
    const calls = failGets(memory, [rateLimited(9_000)]);
    let polls = 0;
    await client.waitUntilActive("app.customer.com", {
      intervalMs: 1_000,
      onStatus: () => {
        if (++polls === 1) memory.activate("app.customer.com");
      },
    });
    expect(calls()).toBe(3);
    expect(sleeps).toEqual([9_000, 1_500]);
  });

  test("rejects invalid backoff options", async () => {
    const client = createDomainClient({ provider: memoryProvider() });
    await expect(
      client.waitUntilActive("app.customer.com", { backoffFactor: 0.5 }),
    ).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    await expect(
      client.waitUntilActive("app.customer.com", { intervalMs: 5_000, maxIntervalMs: 1_000 }),
    ).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    for (const invalid of [{ backoffFactor: Number.NaN }, { maxIntervalMs: Number.NaN }])
      await expect(client.waitUntilActive("app.customer.com", invalid)).rejects.toMatchObject({
        code: "REQUEST_FAILED",
      });
  });

  test("shortens the last wait to poll once more at the deadline", async () => {
    const memory = memoryProvider();
    const { sleeps, clock } = fakeClock();
    const client = createDomainClient({ provider: memory, clock });
    await client.add("app.customer.com");
    let polls = 0;
    const active = await client.waitUntilActive("app.customer.com", {
      timeoutMs: 30_000,
      onStatus: () => {
        if (++polls === 4) memory.activate("app.customer.com");
      },
    });
    expect(active.status).toBe("active");
    expect(sleeps).toEqual([5_000, 7_500, 11_250, 6_250]);
  });

  test("times out when the provider's Retry-After passes the deadline", async () => {
    const memory = memoryProvider();
    const { sleeps, clock } = fakeClock();
    const client = createDomainClient({ provider: memory, clock });
    await client.add("app.customer.com");
    failGets(memory, [rateLimited(60_000)]);
    await expect(
      client.waitUntilActive("app.customer.com", { timeoutMs: 30_000 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(sleeps).toEqual([]);
  });
});

describe("createDnsClient retries and locking", () => {
  test("retries a rate-limited zone read before writing", async () => {
    const provider = memoryDnsProvider();
    const { listRecords } = provider;
    let reads = 0;
    provider.listRecords = (input, context) =>
      reads++ === 0 ? Promise.reject(rateLimited(5)) : listRecords(input, context);
    const dns = createDnsClient({ provider });
    const written = await dns.ensureRecords([
      { type: "A", name: "app.example.com", value: "192.0.2.1" },
    ]);
    expect(written).toHaveLength(1);
    expect(reads).toBe(3);
  });

  test("never repeats a replacement that was rolled back", async () => {
    const provider = memoryDnsProvider({
      zones: { "example.com": [{ type: "A", name: "example.com", value: "192.0.2.1" }] },
    });
    let creates = 0;
    provider.createRecords = () => {
      creates += 1;
      return Promise.reject(unavailable());
    };
    const dns = createDnsClient({ provider, retry: { baseDelayMs: 1 } });
    await expect(
      dns.ensureRecords([{ type: "A", name: "example.com", value: "76.76.21.21" }], {
        onConflict: "replace",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { restored: false } });
    expect(creates).toBe(2);
  });

  test("runs every zone operation inside a custom lock", async () => {
    const provider = memoryDnsProvider();
    const held: string[] = [];
    let active = 0;
    const lock: DnsZoneLock = async (zone, task) => {
      held.push(zone);
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
      }
    };
    const dns = createDnsClient({ provider, lock });
    const record = { type: "TXT" as const, name: "_verify.example.com", value: "token" };
    await dns.ensureRecords([record]);
    await dns.removeRecords([record]);
    expect(held).toEqual(["example.com", "example.com"]);
    expect(active).toBe(0);
    expect(provider.records("example.com")).toEqual([]);
  });

  test("a custom lock replaces the in-memory queue", async () => {
    const provider = memoryDnsProvider();
    let running = 0;
    let overlapped = false;
    const { listRecords } = provider;
    provider.listRecords = async (input, context) => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return listRecords(input, context);
    };
    const noLock: DnsZoneLock = (_zone, task) => task();
    const dns = createDnsClient({ provider, lock: noLock });
    await Promise.all([
      dns.ensureRecords([{ type: "TXT", name: "a.example.com", value: "1" }]),
      dns.ensureRecords([{ type: "TXT", name: "b.example.com", value: "2" }]),
    ]);
    expect(overlapped).toBe(true);
  });

  test("ensureRecords reads the zone once when nothing needs writing", async () => {
    const record = { type: "A" as const, name: "app.example.com", value: "192.0.2.1" };
    const provider = memoryDnsProvider({ zones: { "example.com": [record] } });
    const { listRecords } = provider;
    let reads = 0;
    provider.listRecords = (input, context) => {
      reads += 1;
      return listRecords(input, context);
    };
    const dns = createDnsClient({ provider });
    const result = await dns.ensureRecords([record]);
    expect(result).toMatchObject([{ type: "A", name: "app.example.com", value: "192.0.2.1" }]);
    expect(reads).toBe(1);

    await dns.ensureRecords([{ ...record, name: "www.example.com" }]);
    expect(reads).toBe(3);
  });
});
