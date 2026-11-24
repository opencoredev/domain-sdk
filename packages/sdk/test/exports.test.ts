import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import manifest from "../package.json";

describe("published package exports", () => {
  test("loads every built subpath", async () => {
    expect(await import("@opencoredev/domain-sdk")).toHaveProperty("createDomainClient");
    expect(await import("@opencoredev/domain-sdk")).toHaveProperty("createSubdomainClient");
    expect(await import("@opencoredev/domain-sdk/vercel")).toHaveProperty("vercel");
    expect(await import("@opencoredev/domain-sdk/cloudflare")).toHaveProperty("cloudflareSaaS");
    expect(await import("@opencoredev/domain-sdk/railway")).toHaveProperty("railway");
    expect(await import("@opencoredev/domain-sdk/render")).toHaveProperty("render");
    expect(await import("@opencoredev/domain-sdk/netlify")).toHaveProperty("netlify");
    expect(await import("@opencoredev/domain-sdk/bunny")).toHaveProperty("bunny");
    expect(await import("@opencoredev/domain-sdk/porkbun")).toHaveProperty("porkbun");
    expect(await import("@opencoredev/domain-sdk/namecheap")).toHaveProperty("namecheap");
    expect(await import("@opencoredev/domain-sdk/spaceship")).toHaveProperty("spaceship");
    expect(await import("@opencoredev/domain-sdk/testing")).toHaveProperty("memoryProvider");
  });

  test("exports the DNS record helpers adapter authors need as values", async () => {
    const sdk = await import("@opencoredev/domain-sdk");
    expect(sdk.normalizeZone("Example.com.")).toBe("example.com");
    expect(sdk.normalizeRecordName("@", "example.com")).toBe("example.com");
    expect(sdk.relativeRecordName("www.example.com", "example.com")).toBe("www");
    expect(sdk.absoluteRecordName("www", "example.com")).toBe("www.example.com");
    expect(sdk.canonicalRecordValue("CNAME", "Target.Example.net.")).toBe("target.example.net");
    expect(sdk.parseCaaValue('0 issue "letsencrypt.org"')).toEqual({
      flag: 0,
      tag: "issue",
      value: "letsencrypt.org",
    });
    expect(sdk.formatCaaValue(0, "ISSUE", "letsencrypt.org")).toBe('0 issue "letsencrypt.org"');
    expect(
      sdk.sameRecord(
        { type: "cname", name: "app.example.com", value: "t.example.net." },
        { type: "CNAME", name: "app.example.com", value: "t.example.net" },
      ),
    ).toBe(true);
  });

  test("subpath entries share one DomainSdkError class with the root entry", async () => {
    const { DomainSdkError } = await import("@opencoredev/domain-sdk");
    const { netlify } = await import("@opencoredev/domain-sdk/netlify");
    const { memoryProvider } = await import("@opencoredev/domain-sdk/testing");
    let caught: unknown;
    try {
      netlify({ accessToken: "", siteId: "site" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainSdkError);
    const { createDomainClient } = await import("@opencoredev/domain-sdk");
    await expect(
      createDomainClient({ provider: memoryProvider() }).get("missing.example.com"),
    ).rejects.toBeInstanceOf(DomainSdkError);
  });

  test("every subpath and package.json resolve through require and default conditions", () => {
    const subpaths = Object.keys(manifest.exports).map((key) =>
      key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`,
    );
    const script = `
      const { createRequire } = require("node:module");
      const local = createRequire(${JSON.stringify(join(import.meta.dir, "..", "package.json"))});
      const resolved = ${JSON.stringify(subpaths)}.map((id) => local.resolve(id));
      console.log(JSON.stringify({ resolved, version: local("${manifest.name}/package.json").version }));
    `;
    const result = Bun.spawnSync(["node", "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    const output = JSON.parse(result.stdout.toString()) as { resolved: string[]; version: string };
    expect(output.version).toBe(manifest.version);
    expect(output.resolved).toHaveLength(subpaths.length);
    for (const path of output.resolved) expect(path).toMatch(/\/(dist\/.+\.js|package\.json)$/);
  });
});
