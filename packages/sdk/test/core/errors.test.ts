import { expect, test } from "bun:test";
import { DomainSdkError } from "../../src";
import { parseRetryAfter, redact } from "../../src/core/errors";

test("redacts Railway project access token headers", () => {
  expect(
    redact({
      headers: { "project-access-token": "secret-token", "content-type": "application/json" },
    }),
  ).toEqual({
    headers: { "project-access-token": "[REDACTED]", "content-type": "application/json" },
  });
});

test("redacts secrets recursively and bounds strings", () => {
  const safe = redact({
    apiToken: "secret",
    nested: { authorization: "Bearer abc", message: `Bearer token123 ${"x".repeat(2000)}` },
  });
  expect(safe).toEqual({
    apiToken: "[REDACTED]",
    nested: { authorization: "[REDACTED]", message: expect.stringContaining("Bearer [REDACTED]") },
  });
  expect(
    JSON.stringify(
      new DomainSdkError("REQUEST_FAILED", "Bearer abc", { details: { password: "p" } }),
    ),
  ).not.toContain("abc");
});

test("parses Retry-After seconds and dates", () => {
  expect(parseRetryAfter("2", 0)).toBe(2000);
  expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1000)).toBe(4000);
});

test("redacts the bunny.net AccessKey header and other access credentials", () => {
  expect(
    redact({
      headers: { AccessKey: "bunny-key", "content-type": "application/json" },
      access_token: "oauth",
      accessToken: "netlify",
    }),
  ).toEqual({
    headers: { AccessKey: "[REDACTED]", "content-type": "application/json" },
    access_token: "[REDACTED]",
    accessToken: "[REDACTED]",
  });
});

test("keeps a wrapped cause's name, stack, and code while redacting its message", () => {
  class ProviderSocketError extends Error {
    readonly code = "ECONNRESET";
    constructor(message: string) {
      super(message);
      this.name = "ProviderSocketError";
    }
  }
  const original = new ProviderSocketError("socket closed for Bearer sk_live_abc123");
  const error = new DomainSdkError("PROVIDER_UNAVAILABLE", "Down.", { cause: original });
  const cause = error.cause as Error & { code?: string };
  expect(cause).toBeInstanceOf(Error);
  expect(cause.name).toBe("ProviderSocketError");
  expect(cause.message).toBe("socket closed for Bearer [REDACTED]");
  expect(cause.code).toBe("ECONNRESET");
  expect(cause.stack).toStartWith("ProviderSocketError: socket closed for Bearer [REDACTED]");
  // The original frames survive, so the failure can still be traced to where it was thrown.
  const frames = (stack: string | undefined) => stack?.split("\n").slice(1).join("\n");
  expect(frames(cause.stack)).toBe(frames(original.stack));
  expect(frames(cause.stack)).toContain("errors.test.ts");
  expect(cause.stack).not.toContain("sk_live_abc123");
});

test("recursively redacts nested fetch error causes and handles circular causes", () => {
  const socketError = Object.assign(new Error("connect failed Bearer secret_nested"), {
    code: "ENOTFOUND",
  });
  const fetchError = new TypeError("fetch failed", { cause: socketError });
  const wrapped = new DomainSdkError("PROVIDER_UNAVAILABLE", "Down.", { cause: fetchError });
  const cause = wrapped.cause as Error & { cause?: Error & { code?: string } };
  expect(cause).toBeInstanceOf(Error);
  expect(cause.name).toBe("TypeError");
  expect(cause.cause).toBeInstanceOf(Error);
  expect(cause.cause?.code).toBe("ENOTFOUND");
  expect(cause.cause?.message).toBe("connect failed Bearer [REDACTED]");

  const cyclic = new Error("loop") as Error & { cause?: unknown };
  cyclic.cause = cyclic;
  const wrappedCycle = new DomainSdkError("UNKNOWN_ERROR", "Loop.", { cause: cyclic });
  expect((wrappedCycle.cause as Error).cause).toBe("[Circular]");

  const inline = new Error("provider returned access_token=supersecret and AccessKey: bunnysecret");
  const wrappedInline = new DomainSdkError("UNKNOWN_ERROR", "Failed.", { cause: inline });
  const scrubbed = wrappedInline.cause as Error;
  expect(scrubbed.message).not.toContain("supersecret");
  expect(scrubbed.message).not.toContain("bunnysecret");
  expect(scrubbed.stack).not.toContain("supersecret");
  expect(scrubbed.stack).not.toContain("bunnysecret");

  const quotedJson = JSON.stringify({
    apiKey: "pk_live_123",
    secretapikey: "sk_live_456",
    access_token: 'tok_"escaped"_789',
    authorization: "Basic dXNlcjpwYXNz",
  });
  const doubleEncoded = JSON.stringify(quotedJson);
  const wrappedJson = new DomainSdkError(
    "REQUEST_FAILED",
    `${quotedJson} ${doubleEncoded} cf_api_key=cf_secret_999 Authorization: Token tok_header_888`,
    {
      cause: new Error(`${quotedJson} ${doubleEncoded}`),
      details: { response: `${quotedJson} ${doubleEncoded}` },
    },
  );
  for (const secret of [
    "pk_live_123",
    "sk_live_456",
    "tok_",
    "dXNlcjpwYXNz",
    "cf_secret_999",
    "tok_header_888",
  ]) {
    expect(wrappedJson.message).not.toContain(secret);
    expect((wrappedJson.cause as Error).message).not.toContain(secret);
    expect((wrappedJson.cause as Error).stack).not.toContain(secret);
    expect(JSON.stringify(wrappedJson.details)).not.toContain(secret);
  }
});

test("readJson redacts malformed JSON before truncating the error preview", async () => {
  const { readJson } = await import("../../src/core/http");
  const padding = "x".repeat(970);
  const body = `{"pad":"${padding}","apiKey":"secret_part_1 secret_part_2_tail"} broken`;
  let caught: unknown;
  try {
    await readJson(new Response(body, { status: 500 }), undefined, "vercel");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainSdkError);
  const err = caught as DomainSdkError;
  expect(err.provider).toBe("vercel");
  expect(String(err.details?.response)).not.toContain("secret_part_1");
  expect(String(err.details?.response)).not.toContain("secret_part_2");
});
