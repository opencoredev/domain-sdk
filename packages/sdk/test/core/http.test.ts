import { describe, expect, test } from "bun:test";
import { DomainSdkError } from "../../src";
import { isTransientError, readJson, withRetry } from "../../src/core/http";

describe("readJson", () => {
  test("parses bodies larger than 16 KB", async () => {
    const records = Array.from({ length: 2_000 }, (_, index) => ({
      id: `rec_${index}`,
      name: `host-${index}.example.com`,
    }));
    const text = JSON.stringify({ records });
    expect(text.length).toBeGreaterThan(16_000);
    const body = (await readJson(new Response(text))) as { records: unknown[] };
    expect(body.records).toHaveLength(2_000);
    expect(body.records.at(-1)).toEqual({ id: "rec_1999", name: "host-1999.example.com" });
  });

  test("keeps only a short preview of malformed bodies", async () => {
    const error = await readJson(new Response(`{${"x".repeat(50_000)}`, { status: 502 })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "REQUEST_FAILED", statusCode: 502, retryable: true });
    expect(error).toBeInstanceOf(DomainSdkError);
    expect(String((error as DomainSdkError).details?.["response"])).toHaveLength(1_000);
  });

  test("returns undefined for an empty body", async () => {
    expect(await readJson(new Response(""))).toBeUndefined();
  });
});

describe("withRetry", () => {
  const failing = (errors: DomainSdkError[]) => {
    let calls = 0;
    const operation = async () => {
      const error = errors[calls++];
      if (error) throw error;
      return "ok";
    };
    return { operation, calls: () => calls };
  };
  const recordSleeps = () => {
    const sleeps: number[] = [];
    return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
  };

  test("waits Retry-After on 429 and succeeds", async () => {
    const { operation, calls } = failing([
      new DomainSdkError("RATE_LIMITED", "Slow down.", {
        statusCode: 429,
        retryable: true,
        retryAfter: 2_000,
      }),
    ]);
    const { sleeps, sleep } = recordSleeps();
    expect(await withRetry(operation, { sleep })).toBe("ok");
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([2_000]);
  });

  test("caps Retry-After at maxDelayMs", async () => {
    const limited = new DomainSdkError("RATE_LIMITED", "Slow down.", {
      retryable: true,
      retryAfter: 60_000,
    });
    const { operation } = failing([limited, limited]);
    const { sleeps, sleep } = recordSleeps();
    expect(await withRetry(operation, { sleep, retry: { maxDelayMs: 5_000 } })).toBe("ok");
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  test("backs off exponentially with full jitter on 503", async () => {
    const down = new DomainSdkError("PROVIDER_UNAVAILABLE", "Down.", {
      statusCode: 503,
      retryable: true,
    });
    const { operation, calls } = failing([down, down, down]);
    const { sleeps, sleep } = recordSleeps();
    const random = Math.random;
    Math.random = () => 0.5;
    try {
      await expect(
        withRetry(operation, { sleep, retry: { maxAttempts: 3, baseDelayMs: 100 } }),
      ).rejects.toBe(down);
    } finally {
      Math.random = random;
    }
    expect(calls()).toBe(3);
    expect(sleeps).toEqual([50, 100]);
  });

  test("stops after maxAttempts and never retries permanent failures", async () => {
    const auth = new DomainSdkError("AUTHENTICATION_FAILED", "No.", { statusCode: 401 });
    const once = failing([auth]);
    await expect(withRetry(once.operation, { sleep: async () => {} })).rejects.toBe(auth);
    expect(once.calls()).toBe(1);

    const down = new DomainSdkError("PROVIDER_UNAVAILABLE", "Down.", { retryable: true });
    const disabled = failing([down]);
    await expect(withRetry(disabled.operation, { retry: { maxAttempts: 1 } })).rejects.toBe(down);
    expect(disabled.calls()).toBe(1);
  });

  test("classifies only rate limits and 502/503/504 or network outages as transient", () => {
    const unavailable = (statusCode?: number) =>
      new DomainSdkError("PROVIDER_UNAVAILABLE", "Down.", { statusCode, retryable: true });
    expect(isTransientError(unavailable())).toBe(true);
    expect(isTransientError(unavailable(502))).toBe(true);
    expect(isTransientError(unavailable(504))).toBe(true);
    expect(isTransientError(unavailable(500))).toBe(false);
    expect(isTransientError(new DomainSdkError("RATE_LIMITED", "x", { retryable: true }))).toBe(
      true,
    );
    expect(isTransientError(new DomainSdkError("RATE_LIMITED", "x"))).toBe(false);
    expect(isTransientError(new Error("boom"))).toBe(false);
  });

  test("rejects invalid retry options", async () => {
    await expect(withRetry(async () => 1, { retry: { maxAttempts: 0 } })).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
  });
});
