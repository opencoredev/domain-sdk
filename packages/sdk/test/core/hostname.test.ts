import { describe, expect, test } from "bun:test";
import { DomainSdkError, normalizeHostname } from "../../src";

describe("normalizeHostname", () => {
  test.each([
    [" App.Customer.COM ", "app.customer.com"],
    ["app.customer.com.", "app.customer.com"],
    ["bücher.example", "xn--bcher-kva.example"],
  ])("normalizes %s", (input, expected) => expect(normalizeHostname(input)).toBe(expected));

  test.each([
    "",
    "localhost",
    "127.0.0.1",
    "https://example.com",
    "example.com/path",
    "example.com:443",
    "user@example.com",
    "*.example.com",
    "a..example.com",
    "-a.example.com",
    "example",
    "xn--.example",
  ])("rejects %s", (input) => {
    expect(() => normalizeHostname(input)).toThrow(DomainSdkError);
    try {
      normalizeHostname(input);
    } catch (error) {
      expect((error as DomainSdkError).code).toBe("INVALID_HOSTNAME");
    }
  });

  test("allows a wildcard only when requested by a capable provider", () => {
    expect(normalizeHostname("*.Customer.COM", { allowWildcard: true })).toBe("*.customer.com");
    expect(() => normalizeHostname("*.customer.com")).toThrow(DomainSdkError);
  });
});
