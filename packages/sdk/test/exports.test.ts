import { describe, expect, test } from "bun:test";

describe("published package exports", () => {
  test("loads every built subpath", async () => {
    expect(await import("@opencoredev/domain-sdk")).toHaveProperty("createDomainClient");
    expect(await import("@opencoredev/domain-sdk/vercel")).toHaveProperty("vercel");
    expect(await import("@opencoredev/domain-sdk/cloudflare")).toHaveProperty("cloudflareSaaS");
    expect(await import("@opencoredev/domain-sdk/railway")).toHaveProperty("railway");
    expect(await import("@opencoredev/domain-sdk/render")).toHaveProperty("render");
    expect(await import("@opencoredev/domain-sdk/netlify")).toHaveProperty("netlify");
    expect(await import("@opencoredev/domain-sdk/testing")).toHaveProperty("memoryProvider");
  });
});
