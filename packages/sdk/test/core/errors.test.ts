import { expect, test } from "bun:test";
import { DomainSdkError } from "../../src";
import { parseRetryAfter, redact } from "../../src/core/errors";

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
